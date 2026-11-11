import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  articleTitle,
  localizationMissingTitle,
  localizationStillOpen,
  mergeLocalizationMap,
  nextOfficialLocalizationRefresh,
  OFFICIAL_LOCALIZATION_REFRESH_DELAYS_MS,
  readyLocalizationTitle,
} from '../apps/web/public/feed-localization.js';

const ENGLISH = 'Nominations and Withdrawals Sent to the Senate';
const CHINESE = '已发送至参议院的提名与撤回';

test('a translation that finishes after the list load replaces the empty row', () => {
  const pending = {
    'wh-1': { id: 'wh-1', text: '', pending: true, status: 'pending', sourceText: ENGLISH },
  };
  const ready = mergeLocalizationMap(pending, {
    'wh-1': { id: 'wh-1', text: CHINESE, pending: false, status: 'ready', sourceText: ENGLISH },
  });
  assert.equal(ready['wh-1'].text, CHINESE);
  assert.equal(ready['wh-1'].status, 'ready');
  assert.equal(localizationStillOpen(ready['wh-1']), false);
  assert.equal(articleTitle({
    lang: 'translation',
    localized: ready['wh-1'].text,
    displayed: ENGLISH,
    original: ENGLISH,
  }), CHINESE);
});

test('a stale or in-flight snapshot does not wipe a title that already arrived', () => {
  const current = {
    'wh-1': { id: 'wh-1', text: CHINESE, pending: false, status: 'ready', sourceText: ENGLISH },
    'wh-2': { id: 'wh-2', text: '2026年退伍军人节', pending: false, status: 'ready' },
  };
  const stale = mergeLocalizationMap(current, {
    'wh-1': { id: 'wh-1', text: '', pending: true, status: 'pending', sourceText: ENGLISH },
    'wh-2': { id: 'wh-2', text: '', pending: false, status: 'failed', sourceText: 'VETERANS DAY, 2026' },
    'wh-3': { id: 'wh-3', text: '', pending: true, status: 'pending' },
  });
  assert.equal(stale['wh-1'].text, CHINESE);
  assert.equal(stale['wh-1'].status, 'ready');
  assert.equal(stale['wh-2'].text, '2026年退伍军人节');
  assert.equal(stale['wh-3'].status, 'pending');
  assert.equal(stale, mergeLocalizationMap(stale, {
    'wh-1': { id: 'wh-1', text: '', pending: true, status: 'pending' },
  }));
  const corrected = mergeLocalizationMap(stale, {
    'wh-1': { id: 'wh-1', text: '已送参议院的提名与撤回', pending: false, status: 'ready' },
  });
  assert.equal(corrected['wh-1'].text, '已送参议院的提名与撤回');
  assert.notEqual(corrected, stale);
});

test('the reader uses the list title while full text is still loading', () => {
  assert.equal(articleTitle({
    lang: 'translation',
    localized: CHINESE,
    displayed: ENGLISH,
    original: ENGLISH,
  }), CHINESE);
  assert.equal(articleTitle({
    lang: 'original',
    localized: CHINESE,
    displayed: ENGLISH,
    original: ENGLISH,
  }), ENGLISH);
  assert.equal(articleTitle({
    lang: 'translation',
    localized: '正在翻译…',
    displayed: ENGLISH,
    original: ENGLISH,
  }), '正在翻译…');
  assert.equal(articleTitle({
    lang: 'translation',
    localized: '',
    displayed: ENGLISH,
    original: ENGLISH,
  }), ENGLISH);
  assert.equal(readyLocalizationTitle('无标题'), '');
  assert.equal(localizationMissingTitle({ text: '', pending: false, status: 'failed' }), true);
  assert.equal(localizationMissingTitle({ text: CHINESE, pending: false, status: 'ready' }), false);
  assert.equal(localizationStillOpen({ text: '', pending: true, status: 'pending' }), true);
  assert.equal(localizationStillOpen({ text: '', pending: false, status: 'failed' }), false);
});

test('official title refresh backs off and then stops', () => {
  assert.deepEqual(
    OFFICIAL_LOCALIZATION_REFRESH_DELAYS_MS.map((_, index) => nextOfficialLocalizationRefresh(index)),
    [...OFFICIAL_LOCALIZATION_REFRESH_DELAYS_MS],
  );
  assert.equal(nextOfficialLocalizationRefresh(OFFICIAL_LOCALIZATION_REFRESH_DELAYS_MS.length), 0);
});

test('the feed keeps a pending official title and refreshes it instead of painting 无标题', () => {
  const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const list = app.slice(app.indexOf('function feedListTitle'), app.indexOf('function feedSourceLine'));
  assert.match(list, /original === '正在翻译…'/);
  assert.doesNotMatch(list, /正在翻译…' \? original : '无标题'/);
  assert.match(app, /mergeLocalizationMap\(state\.sourceLocalizations/);
  assert.match(app, /articleTitle\(\{/);
  assert.match(app, /officialLocalizationMissing\(\)/);
  assert.match(app, /scheduleOfficialLocalizationRefresh\(\)/);
  assert.match(app, /loadStaticSignalBoard\(\{ refresh: true \}\)/);
  const request = readFileSync(new URL('../apps/web/public/client-request.js', import.meta.url), 'utf8');
  assert.match(request, /localizationsStillPending\(value\)/);
});
