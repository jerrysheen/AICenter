import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createAiCenterServer } from '../apps/web/src/server.js';
import { createReadingHourService } from '../packages/domain/src/reading-hour-service.js';
import { emptyReadingHourPayload } from '../packages/contracts/src/information-tree.js';
import { parseStructuredPricePage } from '../packages/connectors/src/trendforce-prices.js';

const catalogIds = new Set(['ai', 'market_cn', 'market_us', 'corporate_results', 'communications', 'software', 'ai_model']);

function xItem(index) {
  return {
    id: `x:${index}`,
    workspaceId: 'local',
    platform: 'x',
    externalId: String(index),
    authorName: 'OpenAI',
    authorHandle: '@OpenAI',
    title: `第 ${index} 条`,
    summary: `第 ${index} 条`,
    body: `第 ${index} 条`,
    sourceUrl: `https://x.com/OpenAI/status/${index}`,
    publishedAt: 1_000 + index,
    processing: '',
    subscriptionId: '',
    captureId: '',
  };
}

test('x feed page 2 and an older hour return stored content off the request thread', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-offthread-'));
  let calls = 0;
  const twitterService = {
    async getFeed() {
      calls += 1;
      return {
        platform: 'x',
        feed: 'following',
        handle: '',
        mode: 'live',
        fetchedAt: 1,
        note: 'live',
        source: 'browser_runtime_home',
        items: Array.from({ length: 20 }, (_, index) => xItem(index + 1)),
      };
    },
  };
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    twitterService,
    feedFilter: null,
  });
  const address = await app.listen();
  try {
    const live = await fetch(`${address.localUrl}/api/v1/feed/x?feed=following&limit=12&refresh=1`).then((response) => response.json());
    assert.equal(live.ok, true, JSON.stringify(live));
    assert.equal(calls, 1);
    assert.equal(live.feed.items.length, 12);
    assert.ok(live.feed.nextCursor);
    const started = performance.now();
    const page = await fetch(`${address.localUrl}/api/v1/feed/x?feed=following&limit=12&before=${encodeURIComponent(live.feed.nextCursor)}`).then((response) => response.json());
    const page2Ms = performance.now() - started;
    assert.equal(page.ok, true, JSON.stringify(page));
    assert.equal(page.pending, undefined);
    assert.equal(calls, 1);
    assert.ok(page.feed.items.length > 0);
    const seen = new Set(live.feed.items.map((item) => item.id));
    assert.equal(page.feed.items.some((item) => seen.has(item.id)), false);

    const startAt = Date.parse('2024-01-15T00:00:00Z');
    const endAt = startAt + 3_600_000;
    const reading = createReadingHourService({
      repository: app.store.repositories.informationTree,
      enabled: true,
      now: () => endAt,
    });
    const published = reading.publish('local', {
      window: { startAt, endAt },
      timezone: 'Asia/Shanghai',
      scope: 'hour',
      questionVersion: '2026-10-10.4',
      catalogIds,
      items: [{
        sourceId: 'older',
        sourceVersion: '1',
        nodeId: 'n:older',
        title: '更早一小时',
        publisher: '来源',
        reviewed: true,
        semantic: {
          primaryDirection: 'industry',
          subjectKind: 'company_event',
          classificationStatus: 'classified',
          domainTagIds: ['corporate_results'],
          informationTypes: [],
          facts: [],
        },
        scores: { CO_EVENT: { status: 'scored', score: 0.8 } },
      }],
    });
    assert.equal(published.published, true);
    const edition = {
      id: 'edition:older-hour',
      layer: 'hourly',
      status: 'ready',
      roots: ['module:older'],
      window: { startAt, endAt },
      generatedAt: endAt,
    };
    const node = {
      id: 'module:older',
      layer: 'hourly',
      title: '更早一小时',
      text: '这一小时有内容',
      children: [],
      articleIds: [],
      window: { startAt, endAt },
      eventAt: startAt + 1000,
    };
    const db = new Database(path.join(directory, 'ai-center.db'));
    db.prepare('INSERT INTO information_tree_nodes (workspace_id,id,value_json) VALUES (?,?,?)').run('local', node.id, JSON.stringify(node));
    db.prepare('INSERT INTO information_tree_editions (workspace_id,id,value_json) VALUES (?,?,?)').run('local', edition.id, JSON.stringify(edition));
    db.close();

    const hourStarted = performance.now();
    const hourResponse = await fetch(`${address.localUrl}/api/v1/reports/reading-hour?startAt=${startAt}&endAt=${endAt}&scope=hour`);
    const hour = await hourResponse.json();
    const readingMs = performance.now() - hourStarted;
    assert.equal(hourResponse.status, 200);
    assert.equal(hour.pending, undefined);
    assert.equal(hour.snapshot.items[0].title, '更早一小时');
    const missingHour = await fetch(`${address.localUrl}/api/v1/reports/reading-hour?startAt=1&endAt=2&scope=hour`);
    assert.equal(missingHour.status, 200);
    const missingBody = await missingHour.json();
    assert.deepEqual(missingBody, emptyReadingHourPayload());
    assert.equal(missingBody.pending, undefined);

    const editionStarted = performance.now();
    const editionResponse = await fetch(`${address.localUrl}/api/v1/reports/tree/edition?id=${encodeURIComponent(edition.id)}`);
    const editionBody = await editionResponse.json();
    const editionMs = performance.now() - editionStarted;
    assert.equal(editionResponse.status, 200);
    assert.equal(editionBody.pending, undefined);
    assert.equal(editionBody.edition.id, edition.id);
    assert.equal(editionBody.nodes[0].title, '更早一小时');
    const missingEdition = await fetch(`${address.localUrl}/api/v1/reports/tree/edition?id=edition:missing`);
    assert.equal(missingEdition.status, 404);

    const html = `<div class="price-title">DRAM Spot Price (US$/chip, 未稅)</div>
<div class="price-last-update">Last Update 2026-10-05 18:10 (GMT+8)</div>
<table class="price-table"><tr><th>Item</th><th>High</th><th>Low</th><th>Average</th><th>Change</th></tr>
<tr><td>DDR5 16Gb (2Gx8) 4800/5600</td><td>12.00</td><td>8.00</td><td>10.00</td><td>+2%</td></tr></table>`;
    const saved = app.services.hardwarePrices.ingest('local', parseStructuredPricePage(html, {
      pageKey: 'dram',
      title: 'DRAM价表',
      sourceUrl: 'https://www.trendforce.com.tw/price/dram/dram_spot',
      capturedAt: Date.parse('2026-10-05T04:00:00Z'),
    }));
    const quoteStarted = performance.now();
    const quote = await fetch(`${address.localUrl}/api/v1/hardware-prices?snapshotId=${saved.id}`).then((response) => response.json());
    const quoteMs = performance.now() - quoteStarted;
    assert.equal(quote.ok, true, JSON.stringify(quote));
    assert.equal(quote.pending, undefined);
    assert.ok(quote.items.length > 0);
    assert.equal(quote.snapshot.id, saved.id);
    console.log(JSON.stringify({
      page2Ms: Number(page2Ms.toFixed(2)),
      readingMs: Number(readingMs.toFixed(2)),
      editionMs: Number(editionMs.toFixed(2)),
      quoteMs: Number(quoteMs.toFixed(2)),
      page2Items: page.feed.items.length,
    }));
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
