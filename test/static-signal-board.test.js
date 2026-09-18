import test from 'node:test';
import assert from 'node:assert/strict';
import { readStaticSignalBoard } from '../packages/source/src/static/board.js';

const NOW = Date.parse('2026-09-17T04:00:00Z');
const FROM = Date.parse('2026-09-17T00:00:00Z');
const TO = Date.parse('2026-09-24T23:59:59Z');

function event(overrides = {}) {
  return {
    eventId: 'event', country: 'US', authority: 'Authority', eventType: 'economic-release',
    title: 'Consumer Price Index', scheduledAt: Date.parse('2026-09-18T12:30:00Z'),
    scheduledEndAt: null, referencePeriod: null, status: 'scheduled',
    scheduleBasis: 'official-calendar', timePrecision: 'exact',
    sourceUrl: 'https://example.gov/calendar', observedAt: NOW, ...overrides,
  };
}

function release(overrides = {}) {
  return {
    releaseId: 'release', country: 'US', authority: 'Authority', documentType: 'press-release',
    title: 'Official statement', publishedAt: NOW, timePrecision: 'exact', effectiveAt: null, documentNumber: null,
    sourceUrl: 'https://example.gov/release', observedAt: NOW, ...overrides,
  };
}

function fakePort() {
  const manifests = [
    { id: 'calendar.us.fed', title: 'Fed calendar', category: 'calendar', viewKind: 'calendar' },
    { id: 'calendar.us.fomc', title: 'FOMC', category: 'calendar', viewKind: 'calendar' },
    { id: 'calendar.us.bls', title: 'BLS', category: 'calendar', viewKind: 'calendar' },
    { id: 'calendar.cn.scio', title: 'SCIO', category: 'calendar', viewKind: 'calendar' },
    { id: 'policy.us.white-house', title: 'White House', category: 'policy', viewKind: 'official-release' },
    { id: 'policy.us.federal-register', title: 'Federal Register', category: 'policy', viewKind: 'official-release' },
  ];
  const data = {
    'calendar.us.fed': [event({ eventId: 'fed-fomc', title: 'FOMC: FOMC Meeting', eventType: 'central-bank-meeting', scheduledAt: Date.parse('2026-09-17T12:30:00Z') })],
    'calendar.us.fomc': [event({ eventId: 'fomc', title: 'FOMC Meeting', eventType: 'central-bank-meeting', scheduledAt: Date.parse('2026-09-17T12:30:00Z') })],
    'calendar.us.bls': [
      event({ eventId: 'cpi' }),
      event({ eventId: 'minor', title: 'Minor statistical table', scheduledAt: Date.parse('2026-09-19T12:30:00Z') }),
    ],
    'calendar.cn.scio': [event({
      eventId: 'scio', country: 'CN', authority: '国务院新闻办公室', eventType: 'government-meeting',
      title: 'Notice of SCIO press conference', scheduledAt: Date.parse('2026-09-18T02:00:00Z'),
      sourceUrl: 'https://english.scio.gov.cn/notice',
    })],
    'policy.us.white-house': [
      release({ releaseId: 'white-house', authority: 'The White House', sourceUrl: 'https://whitehouse.gov/action' }),
      release({ releaseId: 'duplicate-url', authority: 'The White House', sourceUrl: 'https://whitehouse.gov/action' }),
    ],
    'policy.us.federal-register': [
      release({ releaseId: 'register', authority: 'Federal Register', sourceUrl: 'https://federalregister.gov/document' }),
    ],
  };
  return {
    list() { return manifests; },
    async read(sourceId) {
      const manifest = manifests.find((item) => item.id === sourceId);
      const rows = data[sourceId];
      return {
        sourceId, providerId: 'provider', observedAt: NOW, status: 'ready', warnings: [],
        data: manifest.viewKind === 'calendar'
          ? { available: true, observedAt: NOW, sourceUrl: 'https://example.gov', events: rows, note: '' }
          : { available: true, observedAt: NOW, sourceUrl: 'https://example.gov', releases: rows, note: '' },
      };
    },
  };
}

test('static signal board merges, focuses, dedupes and preserves distinct publication stages', async () => {
  const board = await readStaticSignalBoard(fakePort(), {
    from: FROM, to: TO, focus: true, includeUndated: false, limit: 100, releaseLimit: 50,
  }, { now: () => NOW });

  assert.deepEqual(board.upcoming.map((item) => item.eventId), ['fomc', 'scio', 'cpi']);
  assert.equal(board.upcoming.some((item) => item.eventId === 'minor'), false);
  assert.equal(board.releases.length, 2);
  assert.deepEqual(new Set(board.releases.map((item) => item.authority)), new Set(['The White House', 'Federal Register']));
  assert.equal(board.sourceHealth.length, 6);
  assert.equal(board.sourceHealth.every((item) => item.status === 'ready'), true);
});

test('static signal board returns the complete calendar when focus is disabled', async () => {
  const board = await readStaticSignalBoard(fakePort(), {
    from: FROM, to: TO, focus: false, includeUndated: true, limit: 100, releaseLimit: 50,
  }, { now: () => NOW });
  assert.equal(board.upcoming.some((item) => item.eventId === 'minor'), true);
});
