import { compareSouthboundDeal, createSouthboundClient, mergeTop10 } from '../../connectors/src/southbound.js';
import { classifyHkConnectDay } from '../../domain/src/hk-connect-calendar.js';
import { formatYmd, nextDailyInstant, zonedParts } from '../../domain/src/zoned-time.js';

export const SOUTHBOUND_JOB_TYPE = 'southbound.daily.sync';
export const SOUTHBOUND_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_AT = '17:00,17:30';

export const southboundManifest = Object.freeze({
  id: 'southbound.daily',
  version: '1.0.0',
  capabilities: [SOUTHBOUND_JOB_TYPE],
  jobTypes: [SOUTHBOUND_JOB_TYPE],
});

function parseClock(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error('AI_CENTER_SOUTHBOUND_AT 需要 HH:MM');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('AI_CENTER_SOUTHBOUND_AT 需要 HH:MM');
  return { hour, minute };
}

function addMinutes(clock, minutes) {
  const total = clock.hour * 60 + clock.minute + minutes;
  return { hour: Math.floor(total / 60) % 24, minute: total % 60 };
}

export function southboundClocks(env = process.env) {
  const raw = String(env.AI_CENTER_SOUTHBOUND_AT || DEFAULT_AT).trim();
  const parts = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (!parts.length) throw new Error('AI_CENTER_SOUTHBOUND_AT 需要 HH:MM');
  const primary = parseClock(parts[0]);
  const catchup = parts[1] ? parseClock(parts[1]) : addMinutes(primary, 30);
  return { primary, catchup };
}

export function shanghaiDate(at = Date.now()) {
  return formatYmd(zonedParts(at, SOUTHBOUND_TIMEZONE));
}

export function persistSouthboundDay({ repository, workspaceId, dailyRows, topRows, hkex, fetchedAt }) {
  const byChannel = new Map((dailyRows || []).map((row) => [row.channel, row]));
  const total = byChannel.get('total') || null;
  const compared = compareSouthboundDeal(total?.dealAmt ?? null, hkex ? hkex.dealAmt : null);
  const stamped = ['sh', 'sz', 'total'].flatMap((channel) => {
    const row = byChannel.get(channel);
    if (!row) return [];
    return [{ ...row, checkStatus: compared.checkStatus, checkDiffPct: compared.checkDiffPct, fetchedAt }];
  });
  const savedDaily = repository.upsertDaily(workspaceId, stamped);
  const tradeDate = stamped[0]?.tradeDate || topRows?.[0]?.tradeDate || '';
  const savedTop = saveSouthboundTop10(repository, workspaceId, tradeDate, topRows);
  return { ...compared, tradeDate, savedDaily, savedTop };
}

export function saveSouthboundTop10(repository, workspaceId, tradeDate, topRows) {
  if (!Array.isArray(topRows) || !tradeDate) return 0;
  const legs = topRows.filter((row) => row.channel === 'sh' || row.channel === 'sz');
  const merged = mergeTop10(legs);
  let saved = 0;
  for (const channel of ['sh', 'sz', 'total']) {
    const rows = channel === 'total' ? merged : legs.filter((row) => row.channel === channel);
    saved += repository.replaceTop10(workspaceId, tradeDate, channel, rows);
  }
  return saved;
}

function hasMergedTop10(repository, workspaceId, tradeDate) {
  return repository.listTop10(workspaceId, tradeDate, 'total').length > 0;
}

function northboundReady(repository, workspaceId, tradeDate) {
  if (!repository) return true;
  return Boolean(repository.getDaily(workspaceId, tradeDate, 'total'));
}

export function persistNorthboundDay({ repository, workspaceId, dailyRows, hkex, fetchedAt }) {
  if (!repository) return { checkStatus: 'unchecked', checkDiffPct: null, tradeDate: '', savedDaily: 0 };
  const byChannel = new Map((dailyRows || []).filter((row) => row?.dealAmt != null).map((row) => [row.channel, row]));
  if (!byChannel.get('total') && (byChannel.get('sh') || byChannel.get('sz'))) {
    const sh = byChannel.get('sh');
    const sz = byChannel.get('sz');
    byChannel.set('total', {
      tradeDate: sh?.tradeDate || sz?.tradeDate,
      channel: 'total',
      dealAmt: (sh?.dealAmt || 0) + (sz?.dealAmt || 0),
      dealNum: ((sh?.dealNum || 0) + (sz?.dealNum || 0)) || null,
      source: 'derived',
    });
  }
  const total = byChannel.get('total') || null;
  const compared = compareSouthboundDeal(total?.dealAmt ?? null, hkex ? hkex.dealAmt : null);
  const stamped = ['sh', 'sz', 'total'].flatMap((channel) => {
    const row = byChannel.get(channel);
    if (!row) return [];
    return [{ ...row, checkStatus: compared.checkStatus, checkDiffPct: compared.checkDiffPct, fetchedAt }];
  });
  const savedDaily = repository.upsertDaily(workspaceId, stamped);
  return { ...compared, tradeDate: stamped[0]?.tradeDate || '', savedDaily };
}

export function saveNorthboundTop10(repository, workspaceId, tradeDate, topRows) {
  if (!repository || !Array.isArray(topRows) || !tradeDate) return 0;
  let saved = 0;
  for (const channel of ['sh', 'sz']) {
    const rows = topRows.filter((row) => row.channel === channel);
    if (!rows.length) continue;
    saved += repository.replaceTop10(workspaceId, tradeDate, channel, rows);
  }
  return saved;
}

async function readDayBundle(client, tradeDate) {
  if (client.fetchDayBundle) return client.fetchDayBundle(tradeDate);
  return { southbound: await client.fetchDay(tradeDate), northbound: [] };
}

async function readTop10Bundle(client, tradeDate) {
  if (client.fetchTop10Bundle) return client.fetchTop10Bundle(tradeDate);
  return { southbound: await client.fetchTop10(tradeDate), northbound: [] };
}

async function fillNorthboundOnly({ client, repository, workspaceId, tradeDate, fetchedAt }) {
  const bundle = await readDayBundle(client, tradeDate);
  let hkex = null;
  try {
    hkex = await client.fetchHkex(tradeDate);
  } catch {
    hkex = null;
  }
  let northTop = [];
  try {
    northTop = (await readTop10Bundle(client, tradeDate)).northbound || [];
  } catch {
    northTop = [];
  }
  const saved = persistNorthboundDay({
    repository,
    workspaceId,
    dailyRows: bundle.northbound || [],
    hkex: hkex?.northbound || null,
    fetchedAt,
  });
  const savedTop = saveNorthboundTop10(repository, workspaceId, tradeDate, northTop);
  if (!saved.savedDaily) return { status: 'northbound_missing', tradeDate, savedTop };
  return { status: saved.checkStatus || 'ok', tradeDate, savedTop, northbound: true };
}

async function noteNorthboundBesideTop10({
  client, northboundRepository, northReady, workspaceId, tradeDate, fetchedAt, northRows,
}) {
  if (!northboundRepository) return '';
  try {
    if (!northReady) {
      const filled = await fillNorthboundOnly({
        client,
        repository: northboundRepository,
        workspaceId,
        tradeDate,
        fetchedAt,
      });
      return filled.status === 'northbound_missing' ? 'northbound_missing' : '';
    }
    saveNorthboundTop10(northboundRepository, workspaceId, tradeDate, northRows);
    return '';
  } catch {
    return 'northbound_missing';
  }
}

function noticeFor(status) {
  if (status === 'mismatch') return { badge: '与港交所成交额不一致', note: '' };
  if (status === 'hkex_missing') return { badge: '港交所尚未公布', note: '' };
  if (status === 'late') return { badge: '今日南向尚未公布', note: '' };
  if (status === 'pending') return { badge: '', note: '等待公布' };
  return { badge: '', note: '' };
}

function publishHealth(store, workspaceId, payload) {
  const { badge, note } = noticeFor(payload.status === 'ok' ? 'ok' : payload.status);
  const providerStatus = payload.status === 'mismatch' || payload.status === 'late'
    ? 'unhealthy'
    : payload.status === 'hkex_missing'
      ? 'degraded'
      : 'healthy';
  store?.setProviderHealth?.('southbound', providerStatus, badge || note || '南向资金已更新', {
    tradeDate: payload.tradeDate,
    status: payload.status,
    diffPct: payload.checkDiffPct ?? null,
  });
  store?.repositories?.runtimeSnapshots?.saveSnapshot?.(workspaceId, 'southbound-health', {
    tradeDate: payload.tradeDate,
    status: payload.status,
    badge,
    note,
    diffPct: payload.checkDiffPct ?? null,
  }, payload.fetchedAt || Date.now());
}

export async function syncSouthboundDay(options = {}) {
  const repository = options.repository;
  const workspaceId = options.workspaceId || 'local';
  const now = options.now?.() || Date.now();
  const tradeDate = options.tradeDate || shanghaiDate(now);
  const slot = options.slot === 'catchup' ? 'catchup' : 'primary';
  const mode = options.mode === 'backfill' ? 'backfill' : 'live';
  const calendar = classifyHkConnectDay(tradeDate);
  if (calendar.trading === false) return { status: 'closed', tradeDate, reason: calendar.reason };
  const existing = repository.getDaily(workspaceId, tradeDate, 'total');
  const topped = hasMergedTop10(repository, workspaceId, tradeDate);
  const northboundRepository = options.northboundRepository || null;
  const northReady = northboundReady(northboundRepository, workspaceId, tradeDate);
  const client = options.client || createSouthboundClient(options);
  if (mode === 'live' && existing?.checkStatus === 'ok' && topped) {
    if (northReady) return { status: 'skipped', tradeDate };
    try {
      return await fillNorthboundOnly({
        client,
        repository: northboundRepository,
        workspaceId,
        tradeDate,
        fetchedAt: now,
      });
    } catch (error) {
      return { status: 'northbound_missing', tradeDate, reason: error instanceof Error ? error.message : '北向读取失败' };
    }
  }
  if (mode === 'live' && existing?.checkStatus === 'ok') {
    try {
      const topBundle = await readTop10Bundle(client, tradeDate);
      const savedTop = saveSouthboundTop10(repository, workspaceId, tradeDate, topBundle.southbound || []);
      const northboundStatus = await noteNorthboundBesideTop10({
        client,
        northboundRepository,
        northReady,
        workspaceId,
        tradeDate,
        fetchedAt: now,
        northRows: topBundle.northbound || [],
      });
      const payload = { status: savedTop ? 'ok' : 'top10_missing', tradeDate, savedTop };
      if (northboundStatus) payload.northboundStatus = northboundStatus;
      return payload;
    } catch (error) {
      return { status: 'top10_missing', tradeDate, reason: error instanceof Error ? error.message : '十大成交读取失败' };
    }
  }
  let dailyRows = [];
  let northRows = [];
  try {
    const bundle = await readDayBundle(client, tradeDate);
    dailyRows = bundle.southbound || [];
    northRows = bundle.northbound || [];
  } catch (error) {
    if (mode === 'backfill') throw error;
    const status = slot === 'catchup' ? 'late' : 'pending';
    publishHealth(options.store, workspaceId, { status, tradeDate, fetchedAt: now });
    return { status, tradeDate, reason: error instanceof Error ? error.message : '读取失败' };
  }
  if (!dailyRows.length) {
    if (northboundRepository && northRows.length) {
      let northHkex = null;
      try {
        northHkex = await client.fetchHkex(tradeDate);
      } catch {
        northHkex = null;
      }
      persistNorthboundDay({
        repository: northboundRepository,
        workspaceId,
        dailyRows: northRows,
        hkex: northHkex?.northbound || null,
        fetchedAt: now,
      });
    }
    if (mode === 'backfill') {
      let hkex = null;
      try {
        hkex = await client.fetchHkex(tradeDate);
      } catch {
        hkex = null;
      }
      if (!hkex) {
        if (mode === 'live') publishHealth(options.store, workspaceId, { status: 'closed_by_data', tradeDate, fetchedAt: now });
        return { status: 'closed_by_data', tradeDate };
      }
      return { status: 'eastmoney_missing', tradeDate };
    }
    const status = slot === 'catchup' ? 'late' : 'pending';
    publishHealth(options.store, workspaceId, { status, tradeDate, fetchedAt: now });
    return { status, tradeDate };
  }
  let hkex = null;
  let topRows = [];
  let northTopRows = [];
  try {
    hkex = await client.fetchHkex(tradeDate);
  } catch {
    hkex = null;
  }
  if (options.includeTop10 !== false) {
    try {
      const topBundle = await readTop10Bundle(client, tradeDate);
      topRows = topBundle.southbound || [];
      northTopRows = topBundle.northbound || [];
    } catch {
      topRows = null;
      northTopRows = [];
    }
  }
  const saved = persistSouthboundDay({
    repository,
    workspaceId,
    dailyRows,
    topRows: options.includeTop10 === false ? undefined : topRows,
    hkex,
    fetchedAt: now,
  });
  if (northboundRepository && northRows.length) {
    persistNorthboundDay({
      repository: northboundRepository,
      workspaceId,
      dailyRows: northRows,
      hkex: hkex?.northbound || null,
      fetchedAt: now,
    });
    if (Array.isArray(northTopRows) && northTopRows.length) {
      saveNorthboundTop10(northboundRepository, workspaceId, tradeDate, northTopRows);
    }
  }
  if (mode === 'live') {
    publishHealth(options.store, workspaceId, {
      status: saved.checkStatus,
      tradeDate,
      checkDiffPct: saved.checkDiffPct,
      fetchedAt: now,
    });
  }
  return { status: saved.checkStatus, tradeDate, ...saved };
}

export function prepareSouthboundEnqueue(store, schedule) {
  if (schedule?.jobType !== SOUTHBOUND_JOB_TYPE) return true;
  const slot = schedule.input?.slot || '';
  const open = store?.listOpenJobs?.(SOUTHBOUND_JOB_TYPE) || [];
  return !open.some((job) => (job.input?.slot || '') === slot);
}

export function ensureSouthboundSchedules(store, env = process.env, now = Date.now()) {
  const enabled = String(env.AI_CENTER_SOUTHBOUND_SYNC ?? '1') !== '0';
  const clocks = southboundClocks(env);
  const saved = [];
  for (const [key, slot, clock] of [
    ['southbound.daily.primary', 'primary', clocks.primary],
    ['southbound.daily.catchup', 'catchup', clocks.catchup],
  ]) {
    saved.push(store.upsertJobSchedule({
      workspaceId: 'local',
      key,
      jobType: SOUTHBOUND_JOB_TYPE,
      enabled,
      schedule: { kind: 'daily', timezone: SOUTHBOUND_TIMEZONE, hour: clock.hour, minute: clock.minute },
      input: { slot },
      priority: 0,
      maxAttempts: 2,
      nextRunAt: nextDailyInstant(now - 1, { timeZone: SOUTHBOUND_TIMEZONE, hour: clock.hour, minute: clock.minute }),
    }));
  }
  return saved;
}

export function createSouthboundJobHandlers(deps = {}) {
  return {
    [SOUTHBOUND_JOB_TYPE]: (input = {}) => syncSouthboundDay({
      ...deps,
      tradeDate: input.tradeDate,
      slot: input.slot,
      mode: 'live',
    }),
  };
}
