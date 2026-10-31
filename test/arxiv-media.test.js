import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mediaConfig from '../config/media.json' with { type: 'json' };
import {
  ARXIV_API_URL,
  buildArxivQueryUrl,
  createArxivRequestGate,
  parseArxivApiBody,
  parseArxivCategories,
  parseArxivPaperId,
} from '../packages/connectors/src/media/arxiv-api.js';
import { createMediaConnector } from '../packages/connectors/src/media/port.js';
import { createStore } from '../packages/database/src/index.js';
import { createMediaIngestionService } from '../packages/domain/src/media-ingestion-service.js';

const NOW = Date.parse('2026-10-02T04:00:00Z');
const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

function atom(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
${entries}
</feed>`;
}

function entry({ id, title, summary, updated, published, author = 'Ada Lovelace', category = 'cs.DC' }) {
  return `<entry>
    <id>http://arxiv.org/abs/${id}</id>
    <updated>${updated}</updated>
    <published>${published}</published>
    <title>${title}</title>
    <summary>${summary}</summary>
    <author><name>${author}</name></author>
    <link href="http://arxiv.org/abs/${id}" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/${id}" rel="related" type="application/pdf"/>
    <category term="${category}" scheme="http://arxiv.org/schemas/atom"/>
  </entry>`;
}

function response(body, status = 200) {
  return {
    status,
    headers: { get: () => '' },
    async arrayBuffer() { return Buffer.from(body); },
  };
}

function serviceFor(fetchImpl, gate) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-arxiv-'));
  const store = createStore(path.join(directory, 'test.db'));
  const service = createMediaIngestionService({
    mediaRepository: store.repositories.media,
    feedRepository: store.repositories.feed,
    mediaPort: createMediaConnector({
      ...mediaConfig,
      fetchImpl,
      lookupImpl: PUBLIC_LOOKUP,
      arxivGate: gate,
    }),
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

test('arxiv query uses the official API sorted by lastUpdatedDate', () => {
  assert.deepEqual(parseArxivCategories(undefined), ['cs.DC', 'cs.AR', 'cs.CL', 'cs.LG']);
  assert.deepEqual(parseArxivCategories('cs.LG, nope, cs.CL'), ['cs.LG', 'cs.CL']);
  const url = new URL(buildArxivQueryUrl(['cs.DC', 'cs.LG'], { maxResults: 10 }));
  assert.equal(url.origin + url.pathname, ARXIV_API_URL);
  assert.equal(url.searchParams.get('sortBy'), 'lastUpdatedDate');
  assert.equal(url.searchParams.get('sortOrder'), 'descending');
  assert.match(url.searchParams.get('search_query'), /cat:cs\.DC OR cat:cs\.LG/);
  assert.equal(/rss\.arxiv\.org/.test(url.toString()), false);
  assert.deepEqual(parseArxivPaperId('http://arxiv.org/abs/2601.01234v2'), {
    base: '2601.01234',
    version: 'v2',
    externalId: 'arxiv:2601.01234v2',
    absUrl: 'https://arxiv.org/abs/2601.01234v2',
  });
});

test('api atom keeps abstract separate from deferred html and rejects rss', () => {
  const parsed = parseArxivApiBody(atom(entry({
    id: '2601.01234v2',
    title: '  Scheduling\n memory ',
    summary: 'We study the queue. ',
    updated: '2026-10-01T08:00:00Z',
    published: '2026-09-01T08:00:00Z',
  })));
  assert.equal(parsed.health, 'ready');
  assert.equal(parsed.items[0].externalId, 'arxiv:2601.01234v2');
  assert.equal(parsed.items[0].title, 'Scheduling memory');
  assert.equal(parsed.items[0].summary, 'We study the queue.');
  assert.equal(parsed.items[0].publishedAt, Date.parse('2026-10-01T08:00:00Z'));
  assert.equal(parsed.items[0].fullText.status, 'deferred');
  assert.equal(parsed.items[0].fullText.preferred, 'html');
  assert.match(parsed.items[0].fullText.reason, /^full_text_deferred:html_preferred/);
  assert.match(parsed.items[0].fullText.pdfUrl, /\/pdf\/2601\.01234v2$/);
  assert.equal(parseArxivApiBody('<rss><channel><item><title>weekend</title></item></channel></rss>').health, 'not_api');
  assert.equal(parseArxivApiBody(atom('')).health, 'empty');
});

test('request gate waits at least three seconds between arxiv calls', async () => {
  let clock = 1_000;
  const waits = [];
  const gate = createArxivRequestGate({
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  await gate(1000);
  await gate(1000);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 3000);
});

test('enabled arxiv indexes abstracts by paper version and keeps full text deferred', async () => {
  const urls = [];
  let body = atom(entry({
    id: '2601.01234v1',
    title: 'Scheduling memory',
    summary: 'Version one abstract.',
    updated: '2026-10-01T08:00:00Z',
    published: '2026-09-01T08:00:00Z',
  }));
  let clock = 5_000;
  const gate = createArxivRequestGate({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const fixture = serviceFor(async (url) => {
    urls.push(String(url));
    return response(body);
  }, gate);
  const previous = process.env.AI_CENTER_ARXIV_CATEGORIES;
  process.env.AI_CENTER_ARXIV_CATEGORIES = 'cs.DC,cs.AR,cs.CL,cs.LG';
  try {
    const source = mediaConfig.sources.find((item) => item.sourceKey === 'arxiv');
    assert.equal(source.enabled, false);
    assert.equal(source.transport, 'vendor_api');
    assert.ok(source.minRequestIntervalMs >= 3000);
    assert.equal(fixture.service.enableSource('local', 'arxiv').health, 'needs_host_probe');
    const probe = await fixture.service.probe({ sourceKeys: ['arxiv'], policyReviewed: true, run: true });
    assert.equal(probe.results[0].health, 'ready');
    assert.equal(probe.results[0].items, null);
    assert.equal(fixture.service.enableSource('local', 'arxiv').ok, true);
    const first = await fixture.service.syncEnabled({ workspaceId: 'local', channel: 'tech', force: true });
    assert.equal(first.results.find((item) => item.sourceKey === 'arxiv').added, 1);
    const row = fixture.store.repositories.media.getEntries('local', ['arxiv:2601.01234v1'])[0];
    assert.equal(row.contentLevel, 'summary_only');
    assert.equal(row.summary, 'Version one abstract.');
    assert.equal(row.fetchState.fetchStatus, 'deferred');
    assert.match(row.fetchState.extractionReason, /^full_text_deferred:html_preferred/);
    assert.equal(fixture.store.repositories.media.latestBodies('local', [row.externalId]).length, 0);
    const enriched = fixture.service.listEnrichmentItems('local', 20, [row.externalId]);
    assert.equal(enriched[0].contentLevel, 'summary_only');
    assert.match(enriched[0].text, /Version one abstract/);
    const candidates = fixture.service.informationCandidates('local', { startAt: NOW - 8 * 86400_000, endAt: NOW + 86400_000 });
    assert.equal(candidates.some((item) => item.id === `media:${row.externalId}`), true);
    const blocked = await fixture.service.fetchBodies({ workspaceId: 'local', externalIds: [row.externalId], usageReviewed: true });
    assert.equal(blocked.fetched[0].health, 'full_text_deferred');
    assert.match(fixture.store.repositories.media.getEntries('local', [row.externalId])[0].fetchState.extractionReason, /^full_text_deferred/);
    const again = await fixture.service.syncEnabled({ workspaceId: 'local', channel: 'tech', force: true });
    assert.equal(again.results.find((item) => item.sourceKey === 'arxiv').added, 0);
    assert.equal(fixture.store.repositories.media.listEntries('local', { channel: 'tech', limit: 10 }).filter((item) => item.sourceKey === 'arxiv').length, 1);
    body = atom([
      entry({
        id: '2601.01234v1',
        title: 'Scheduling memory',
        summary: 'Version one abstract.',
        updated: '2026-10-01T08:00:00Z',
        published: '2026-09-01T08:00:00Z',
      }),
      entry({
        id: '2601.01234v2',
        title: 'Scheduling memory',
        summary: 'Version two changes the experiment.',
        updated: '2026-10-02T01:00:00Z',
        published: '2026-09-01T08:00:00Z',
        category: 'cs.LG',
      }),
    ].join(''));
    const updated = await fixture.service.syncEnabled({ workspaceId: 'local', channel: 'tech', force: true });
    assert.equal(updated.results.find((item) => item.sourceKey === 'arxiv').added, 1);
    const versions = fixture.store.repositories.media.listEntries('local', { channel: 'tech', limit: 10 }).filter((item) => item.sourceKey === 'arxiv');
    assert.deepEqual(versions.map((item) => item.externalId).sort(), ['arxiv:2601.01234v1', 'arxiv:2601.01234v2']);
    assert.equal(versions.every((item) => item.contentLevel === 'summary_only'), true);
    assert.equal(urls.every((url) => url.startsWith('https://export.arxiv.org/api/query') && url.includes('sortBy=lastUpdatedDate')), true);
    assert.equal(urls.some((url) => url.includes('rss.arxiv.org')), false);
    assert.equal(fixture.service.enableSource('local', 'reuters').health, 'needs_credentials');
  } finally {
    if (previous == null) delete process.env.AI_CENTER_ARXIV_CATEGORIES;
    else process.env.AI_CENTER_ARXIV_CATEGORIES = previous;
    fixture.remove();
  }
});
