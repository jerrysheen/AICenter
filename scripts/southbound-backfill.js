import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createSouthboundClient, mergeTop10 } from '../packages/connectors/src/southbound.js';
import { createStore } from '../packages/database/src/index.js';
import { addIsoDays, classifyHkConnectDay, eachIsoDate, resolveBackfillStart } from '../packages/domain/src/hk-connect-calendar.js';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';
import { persistSouthboundDay } from '../packages/runtime/src/southbound-job.js';

const from = arg('--from');
const to = arg('--to');
const part = arg('--part', 'all');
if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to || !['all', 'daily', 'top10'].includes(part)) {
  console.error('用法: node scripts/southbound-backfill.js --from YYYY-MM-DD --to YYYY-MM-DD [--part daily|top10|all]');
  process.exit(1);
}

const instance = resolveInstanceConfig({ repositoryRoot: process.cwd() });
const store = createStore(instance.databasePath);
const repository = store.repositories.southbound;
const checkpointPath = path.join(path.dirname(instance.databasePath), 'southbound-backfill.json');
const checkpoint = readCheckpoint(checkpointPath);
const client = createSouthboundClient();
const top10From = part === 'top10' ? from : (addIsoDays(to, -364) > from ? addIsoDays(to, -364) : from);

let stoppedAt = '';

try {
  if (part !== 'top10') await backfillDaily();
  if (!stoppedAt && part !== 'daily') await backfillTop10();
  if (stoppedAt) {
    console.error(`southbound backfill stopped at ${stoppedAt}; rerun the same command to resume`);
    process.exitCode = 1;
  } else {
    console.log(`southbound backfill done from=${from} to=${to} part=${part}`);
  }
} finally {
  store.close();
}

async function backfillDaily() {
  const start = resolveBackfillStart(from, to, checkpoint.dailyThrough);
  if (!start || start > to) {
    console.log(`daily already through ${checkpoint.dailyThrough || to}`);
    return;
  }
  const history = [];
  for (const mutualType of ['002', '004', '006']) {
    for (let cursor = start; cursor <= to; cursor = addIsoDays(chunkEnd(cursor), 1)) {
      const end = chunkEnd(cursor);
      const rows = await client.fetchHistory({ mutualType, start: cursor, end });
      history.push(...rows);
      console.log(`history ${mutualType} ${cursor} ${end} rows=${rows.length}`);
    }
  }
  const byDate = new Map();
  for (const row of history) {
    const list = byDate.get(row.tradeDate) || [];
    list.push(row);
    byDate.set(row.tradeDate, list);
  }
  const counts = { saved: 0, hkexMissing: 0, closedByData: 0, closed: 0 };
  for (const date of eachIsoDate(start, to)) {
    const calendar = classifyHkConnectDay(date);
    if (calendar.trading === false) {
      counts.closed += 1;
      remember('dailyThrough', date);
      continue;
    }
    const dailyRows = byDate.get(date) || [];
    const loaded = await loadHkex(date);
    if (!loaded.ok) return;
    if (!dailyRows.length) {
      if (!loaded.hkex) counts.closedByData += 1;
      console.log(`${date} ${loaded.hkex ? 'eastmoney_missing' : 'closed_by_data'}`);
      remember('dailyThrough', date);
      continue;
    }
    const hkex = loaded.hkex;
    const saved = persistSouthboundDay({
      repository,
      workspaceId: 'local',
      dailyRows,
      hkex,
      fetchedAt: Date.now(),
    });
    if (saved.checkStatus === 'hkex_missing') counts.hkexMissing += 1;
    counts.saved += 1;
    console.log(`${date} ${saved.checkStatus}`);
    remember('dailyThrough', date);
  }
  console.log(`daily saved=${counts.saved} hkex_missing=${counts.hkexMissing} closed_by_data=${counts.closedByData} closed=${counts.closed}`);
}

async function backfillTop10() {
  const start = resolveBackfillStart(top10From, to, checkpoint.top10Through);
  if (!start || start > to) {
    console.log(`top10 already through ${checkpoint.top10Through || to}`);
    return;
  }
  let saved = 0;
  for (const date of eachIsoDate(start, to)) {
    const calendar = classifyHkConnectDay(date);
    if (calendar.trading === false) {
      remember('top10Through', date);
      continue;
    }
    let topRows;
    try {
      topRows = await client.fetchTop10(date);
    } catch (error) {
      stoppedAt = date;
      console.log(`${date} top10 ${error instanceof Error ? error.message : error}`);
      return;
    }
    if (topRows?.length) {
      const legs = topRows.filter((row) => row.channel === 'sh' || row.channel === 'sz');
      const merged = mergeTop10(legs);
      for (const channel of ['sh', 'sz', 'total']) {
        const rows = channel === 'total' ? merged : legs.filter((row) => row.channel === channel);
        repository.replaceTop10('local', date, channel, rows);
      }
      saved += 1;
      console.log(`${date} top10 ${merged.length}`);
    }
    remember('top10Through', date);
  }
  console.log(`top10 saved=${saved}`);
}

async function loadHkex(date) {
  try {
    return { ok: true, hkex: await client.fetchHkex(date) };
  } catch (error) {
    stoppedAt = date;
    console.log(`${date} hkex ${error instanceof Error ? error.message : error}`);
    return { ok: false, hkex: null };
  }
}

function chunkEnd(cursor) {
  const end = addIsoDays(cursor, 59);
  return end < to ? end : to;
}

function remember(key, date) {
  checkpoint[key] = date;
  mkdirSync(path.dirname(checkpointPath), { recursive: true });
  writeFileSync(checkpointPath, `${JSON.stringify(checkpoint)}\n`);
}

function readCheckpoint(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      dailyThrough: String(parsed.dailyThrough || ''),
      top10Through: String(parsed.top10Through || ''),
    };
  } catch {
    return { dailyThrough: '', top10Through: '' };
  }
}

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}
