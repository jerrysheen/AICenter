import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mediaConfig from '../config/media.json' with { type: 'json' };
import { createMediaConnector } from '../packages/connectors/src/media/port.js';
import {
  createSemiRequestGate,
  extractSemiPublicExcerpt,
  semianalysisResearchStatus,
} from '../packages/connectors/src/semianalysis-public.js';
import { createStore } from '../packages/database/src/index.js';
import { createMediaIngestionService } from '../packages/domain/src/media-ingestion-service.js';
import { ValidationError } from '../packages/contracts/src/index.js';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];
const NOW = Date.parse('2026-10-31T02:00:00Z');
const PAGE = 'https://www.semianalysis.com/hbm-demand';
const LEAD = 'A public lead about high bandwidth memory demand in 2026 and the buyers who can take supply.';

function response(body, status = 200) {
  return {
    status,
    headers: { get: () => '' },
    async arrayBuffer() { return Buffer.from(body); },
  };
}

function page(extra = '') {
  return `<html><head><meta property="og:title" content="HBM demand"><meta property="og:description" content="${LEAD}"></head><body><p>${LEAD}</p>${extra}</body></html>`;
}

function fixture(fetchImpl) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-semi-'));
  const store = createStore(path.join(directory, 'test.db'));
  const service = createMediaIngestionService({
    mediaRepository: store.repositories.media,
    feedRepository: store.repositories.feed,
    mediaPort: createMediaConnector({ ...mediaConfig, fetchImpl, lookupImpl: PUBLIC_LOOKUP, arxivGate: async () => {} }),
    now: () => NOW,
  });
  return {
    store,
    service,
    remove() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('research api stays disconnected and newsletter markup is not full text', () => {
  const research = semianalysisResearchStatus();
  assert.equal(research.available, false);
  assert.equal(research.connected, false);
  assert.equal(research.reason, 'not_connected');
  const encoded = `<rss><channel><item><title>Secret</title><content:encoded><![CDATA[${'x'.repeat(5000)}]]></content:encoded></item></channel></rss>`;
  const refused = extractSemiPublicExcerpt(encoded);
  assert.equal(refused.health, 'feed_refused');
  assert.equal(refused.excerpt, '');
  assert.equal(refused.contentLevel, 'partial');
  const source = mediaConfig.sources.find((item) => item.sourceKey === 'semianalysis');
  assert.equal(source.enabled, false);
  assert.equal(source.deployment, 'later');
  assert.ok(source.minRequestIntervalMs >= 3000);
});

test('manual public url saves a partial lead and paywall or feed urls do not', async () => {
  const urls = [];
  let status = 200;
  let body = page('<div class="paywall">Subscribe to continue reading this analysis.</div>');
  const saved = fixture(async (url) => {
    urls.push(String(url));
    return response(body, status);
  });
  try {
    await assert.rejects(() => saved.service.saveManualPartial('local', { url: 'https://semianalysis.com/feed' }), ValidationError);
    await assert.rejects(() => saved.service.saveManualPartial('local', { url: 'https://newsletter.example/post' }), ValidationError);
    assert.equal(urls.length, 0);
    const partial = await saved.service.saveManualPartial('local', { url: PAGE });
    assert.equal(partial.saved, true);
    assert.equal(partial.contentLevel, 'partial');
    const row = saved.store.repositories.media.getEntries('local', [partial.externalId])[0];
    assert.equal(row.contentLevel, 'partial');
    assert.equal(row.truncated, true);
    assert.equal(row.summary, LEAD);
    assert.equal(row.summary.includes('Subscribe'), false);
    const snapshot = saved.store.repositories.media.latestBodies('local', [row.externalId])[0];
    assert.equal(snapshot.contentLevel, 'partial');
    assert.equal(snapshot.bodyText.includes('Subscribe'), false);
    assert.equal(row.fetchState.extractionReason, 'paywall_public_lead');
    const enriched = saved.service.listEnrichmentItems('local', 10, [row.externalId]);
    assert.equal(enriched[0].contentLevel, 'partial');
    assert.match(enriched[0].text, /high bandwidth memory/);
    status = 403;
    body = page();
    const blocked = await saved.service.saveManualPartial('local', { url: 'https://semianalysis.com/members/hbm' });
    assert.equal(blocked.saved, false);
    assert.equal(blocked.health, 'policy_skipped');
    assert.equal(saved.store.repositories.media.listEntries('local', { limit: 10 }).filter((item) => item.sourceKey === 'semianalysis').length, 1);
    saved.store.repositories.media.saveState({
      workspaceId: 'local', sourceKey: 'semianalysis', enabled: true, hostDirectVerified: false,
      bodyUseAcknowledged: false, health: 'disabled', healthDetail: '', etag: '', lastModified: '',
      feedHash: '', lastProbe: null, lastSyncAt: null, updatedAt: NOW,
    });
    const before = urls.length;
    const sync = await saved.service.syncEnabled({ workspaceId: 'local', channel: 'tech', force: true });
    assert.equal(sync.results.find((item) => item.sourceKey === 'semianalysis').health, 'manual_only');
    assert.equal(sync.results.find((item) => item.sourceKey === 'semianalysis').added, 0);
    assert.equal(urls.length, before);
    const probe = await saved.service.probe({ sourceKeys: ['semianalysis'], policyReviewed: true, run: true });
    assert.equal(probe.results[0].health, 'manual_only');
    assert.equal(probe.requestCount, 0);
  } finally {
    saved.remove();
  }
});

test('semi requests wait at least three seconds', async () => {
  let clock = 20;
  const waits = [];
  const gate = createSemiRequestGate({
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
  });
  await gate(500);
  await gate(500);
  assert.ok(waits[0] >= 3000);
});
