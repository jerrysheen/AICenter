import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../apps/web/public/index.html', import.meta.url), 'utf8');

function functionSource(name) {
  const match = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(match, name);
  return match[0];
}

test('authorized start says 同步中 before the live stream is ready', () => {
  const source = functionSource('completeAuthorizedStart');
  const syncAt = source.indexOf("setConnection('waiting', '同步中')");
  const streamAt = source.indexOf('connectStream()');
  assert.ok(syncAt > 0);
  assert.ok(syncAt < streamAt);
  assert.match(html, /正在连接/);
  assert.equal(html.includes('id="connection-state"'), true);
});

test('retry is offered only after ask or knowledge fails', () => {
  assert.match(functionSource('renderAskRecords'), /action: state\.askSessionsError \? '重试' : ''/);
  assert.match(functionSource('renderKnowledge'), /action: state\.knowledgeError \? '重试' : ''/);
  assert.doesNotMatch(functionSource('renderViewState'), /kind === 'loading'[\s\S]*重试/);
});

test('a source page waits for its saved feed before showing the empty sentence', () => {
  const context = vm.createContext({ state: {} });
  vm.runInContext(functionSource('sourceFeedReady'), context);
  context.state = { bilibiliLoading: true, bilibiliLoaded: false, bilibiliNote: '' };
  assert.equal(context.sourceFeedReady('bilibili'), false);
  context.state = { bilibiliLoading: false, bilibiliLoaded: false, bilibiliNote: '' };
  assert.equal(context.sourceFeedReady('bilibili'), false);
  context.state = { bilibiliLoading: false, bilibiliLoaded: true, bilibiliNote: '' };
  assert.equal(context.sourceFeedReady('bilibili'), true);
  context.state = { bilibiliLoading: false, bilibiliLoaded: false, bilibiliNote: '读取失败' };
  assert.equal(context.sourceFeedReady('bilibili'), true);
  assert.equal(context.sourceFeedReady('manual'), true);
  assert.match(functionSource('renderSourcePage'), /正在读取已保存内容…/);
});

test('the overview schedule block keeps a visible empty sentence', () => {
  assert.match(html, /id="static-upcoming"><p class="section-kicker">近期没有日程<\/p>/);
  assert.match(functionSource('renderStaticSignalBoard'), /近期没有日程/);
});

test('a failed brief links to the real previous date and only looks up after that date is missing', () => {
  const context = vm.createContext({});
  vm.runInContext(`${functionSource('briefDateLabel')}\n${functionSource('briefFallbackLink')}`, context);
  const dated = context.briefFallbackLink({ reportDate: '2026-10-05' }, null);
  assert.equal(dated.text, '看上一份（10月5日）');
  assert.equal(dated.href, '#report/2026-10-05');
  assert.equal(dated.lookup, false);
  assert.equal(context.briefFallbackLink({ reportDate: '2026-01-09' }, null).text, '看上一份（1月9日）');
  const missing = context.briefFallbackLink(null, null);
  assert.equal(missing.text, '去简报历史');
  assert.equal(missing.href, '#report/history');
  assert.equal(missing.lookup, true);
  const recovered = context.briefFallbackLink(null, { reportDate: '2026-10-08' });
  assert.equal(recovered.text, '看上一份（10月8日）');
  assert.equal(recovered.lookup, false);
  assert.match(functionSource('lookupPreviousBrief'), /\/api\/v1\/reports\/daily\/briefs/);
  assert.doesNotMatch(functionSource('completeAuthorizedStart'), /lookupPreviousBrief/);
});

test('a pending translation label expires to 暂未翻译 without changing the request', () => {
  const timers = [];
  const context = vm.createContext({
    Date,
    window: { setTimeout: (fn, ms) => { timers.push(ms); return 1; } },
    state: { sourceLocalizations: {}, sourceLocalizing: false },
    renderPosts() {},
    renderOverviewTimeline() {},
    renderStaticSignalBoard() {},
    renderSourcePage() {},
    document: { body: { dataset: {} } },
  });
  vm.runInContext([
    'const TRANSLATION_LABEL_MS = 30_000;',
    'const translationLabels = { source: { startedAt: 0, timer: 0 }, post: { startedAt: 0, timer: 0 } };',
    functionSource('refreshTranslationLabels'),
    functionSource('translationStatusLabel'),
    functionSource('localizedCopy'),
    'this.translationLabels = translationLabels;',
    'this.localizedCopy = localizedCopy;',
  ].join('\n'), context);
  context.state.sourceLocalizations.a = { pending: true, text: '' };
  assert.equal(context.localizedCopy('a', 'English title'), 'English title');
  context.state.sourceLocalizing = true;
  assert.equal(context.localizedCopy('a', 'English title'), '正在翻译…');
  assert.equal(timers[0], 30_000);
  context.translationLabels.source.startedAt = Date.now() - 31_000;
  assert.equal(context.localizedCopy('a', 'English title'), '暂未翻译');
  context.state.sourceLocalizing = false;
  assert.equal(context.localizedCopy('a', 'English title'), '暂未翻译');
  context.state.sourceLocalizations.a.text = '中文标题';
  assert.equal(context.localizedCopy('a', 'English title'), '中文标题');
  assert.match(functionSource('requestTranslation'), /for \(let attempt = 0; attempt < 900; attempt\+\+\)/);
});
