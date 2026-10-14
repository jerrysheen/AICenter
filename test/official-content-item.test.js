import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSourceRoutes } from '../apps/web/src/routes/source-routes.js';
import { createFeedRoutes, projectOfficialContentItem, readOfficialContentItem } from '../apps/web/src/routes/feed-routes.js';

function jsonResponse() {
  return {
    statusCode: 0,
    body: null,
    writeHead(status) { this.statusCode = status; },
    end(payload) { this.body = JSON.parse(String(payload)); },
  };
}

const release = {
  releaseId: '2026-20957',
  title: 'Federal Register notice on reporting requirements',
  authority: 'Federal Register',
  documentNumber: '2026-20957',
  sourceUrl: 'https://www.federalregister.gov/documents/2026/20957',
  publishedAt: 1_700_000_000_000,
};

test('official content items keep the release id and the saved Chinese title', async () => {
  const projected = projectOfficialContentItem(release, {
    text: '联邦公报关于报告要求的通知', status: 'ready', engine: 'gemma',
  }, { bodyText: 'The notice body.' });
  assert.equal(projected.id, 'official/2026-20957');
  assert.equal(projected.title, '联邦公报关于报告要求的通知');
  assert.equal(projected.body, 'The notice body.');
  assert.equal(projected.contentLevel, 'full');
  const services = {
    staticSignalBoard: {
      read: async () => ({ board: { releases: [release], upcoming: [] } }),
    },
    feed: {
      localizeTexts: async () => ({
        pendingIds: [],
        localizations: {
          '2026-20957': { id: '2026-20957', text: '联邦公报关于报告要求的通知', status: 'ready', pending: false },
        },
      }),
    },
    sources: {
      read: async () => ({ data: { available: true, bodyText: 'Indexed notice body.' } }),
    },
  };
  const item = await readOfficialContentItem(services, 'local', 'official/2026-20957');
  assert.equal(item.externalId, '2026-20957');
  assert.equal(item.title, '联邦公报关于报告要求的通知');
  assert.equal(item.body, 'Indexed notice body.');
  assert.equal(await readOfficialContentItem(services, 'local', 'missing'), null);
  const route = createFeedRoutes().find((entry) => entry.path instanceof RegExp && String(entry.path).includes('official'));
  const response = jsonResponse();
  await route.handler({
    response, services, identity: { device: { workspaceId: 'local' } }, params: { values: ['2026-20957'] },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.item.id, 'official/2026-20957');
});

test('board localization enqueues release titles before calendar events', async () => {
  const calls = [];
  const event = { eventId: 'dol-claims-rule:2026:10:15', title: 'Initial Jobless Claims' };
  const route = createSourceRoutes().find((entry) => entry.path === '/api/v1/static-signals/board');
  const response = jsonResponse();
  await route.handler({
    response,
    identity: { device: { workspaceId: 'local' } },
    url: new URL('http://127.0.0.1/api/v1/static-signals/board?from=0&to=1&focus=0&includeUndated=1'),
    services: {
      staticSignalBoard: {
        read: async () => ({ board: { releases: [release], upcoming: [event], sourceHealth: [] }, pending: false }),
      },
      feed: {
        localizeTexts: async (units) => ({
          pendingIds: units.map((unit) => unit.id),
          localizations: Object.fromEntries(units.map((unit) => [unit.id, {
            id: unit.localizationId, text: '', pending: true, status: 'pending', sourceText: unit.text,
          }])),
        }),
      },
      runtime: {
        requestTranslation(input) {
          calls.push(input);
          return { id: 'job-1', priority: 10 };
        },
      },
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].items.map((item) => item.id), ['2026-20957', event.eventId]);
  const focus = JSON.parse(readFileSync(new URL('../packages/source/src/static/focus-events.json', import.meta.url), 'utf8'));
  assert.ok(focus.US.includes('beige book'));
  assert.ok(focus.US.includes('initial jobless claims'));
});
