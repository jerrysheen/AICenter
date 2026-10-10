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

test('official document types render in Chinese and unknown values fall back', () => {
  const labels = app.match(/const DOCUMENT_TYPE_LABELS = \{[^]*?\n\};/);
  assert.ok(labels);
  const context = vm.createContext({});
  vm.runInContext(`${labels[0]}\n${functionSource('documentTypeLabel')}`, context);
  assert.equal(context.documentTypeLabel('press-release'), '新闻稿');
  assert.equal(context.documentTypeLabel('presidential-document'), '总统文件');
  assert.equal(context.documentTypeLabel('notice'), '公告');
  assert.equal(context.documentTypeLabel('other'), '其他');
  assert.equal(context.documentTypeLabel('not-a-real-type'), '其他');
  assert.equal(context.documentTypeLabel(''), '');
  assert.match(functionSource('officialEventMeta'), /documentTypeLabel\(post\.release\?\.documentType\)/);
});

test('flat quote moves are neutral and bond or metal prices keep their units', () => {
  const context = vm.createContext({ formatPrice: (value, digits) => Number(value).toFixed(digits ?? 2) });
  vm.runInContext(`${functionSource('quoteMove')}\n${functionSource('quoteUsesYuanPerTon')}\n${functionSource('formatQuoteNumber')}`, context);
  const flat = context.quoteMove(-0.004);
  const up = context.quoteMove(1.2);
  const down = context.quoteMove(-1.2);
  assert.equal(flat.tone, 'flat');
  assert.equal(flat.text, '0.00%');
  assert.equal(up.tone, 'up');
  assert.equal(up.text, '+1.20%');
  assert.equal(down.tone, 'down');
  assert.equal(down.text, '-1.20%');
  assert.equal(context.formatQuoteNumber({ assetClass: 'rate', symbol: 'US10Y' }, 4.25), '4.2500%');
  assert.equal(context.formatQuoteNumber({ assetClass: 'future', symbol: 'LC', name: '碳酸锂' }, 2807.46), '2807.46 元/吨');
  assert.equal(context.formatQuoteNumber({ assetClass: 'future', symbol: 'CU', name: '沪铜主连' }, 70000), '70000.00 元/吨');
  assert.equal(context.formatQuoteNumber({ assetClass: 'future', symbol: 'M', name: '豆粕' }, 3000), '3000.00');
  assert.match(functionSource('appendDerivativeQuote'), /标记价/);
  assert.match(functionSource('appendDerivativeQuote'), /资金费率/);
  assert.match(functionSource('appendDerivativeQuote'), /持仓量/);
  assert.match(functionSource('appendLiquidityMetric'), /稳定币总量/);
  assert.match(functionSource('renderMarketNativeBoard'), /永续为场所报价，稳定币为供给统计/);
  assert.match(functionSource('renderMarketNativeBoard'), /场所报价，不是综合概率/);
});

test('desktop hints match the pointer, and the stock board shows a clock', () => {
  assert.match(html, /title="快速发布"/);
  assert.match(functionSource('updateHeaderAction'), /button\.title = button\.getAttribute\('aria-label'\)/);
  assert.match(functionSource('syncReloadHint'), /prefersFinePointer\(\) \? '刷新'/);
  assert.match(functionSource('renderStockGeneratedNote'), /生成于 \$\{clock\}/);
  assert.match(html, /id="stock-generated-note"/);
  assert.match(html, /knowledge-hint-desktop">知识库是可长期复用内容的规范层。向左拖动一条可从库中删除。/);
  assert.match(readFileSync(new URL('../apps/web/public/information-tree.js', import.meta.url), 'utf8'), /有新的小时报/);
  const bili = '查看已保存字幕，从「采集与处理」粘贴链接采集';
  assert.equal(app.split(bili).length - 1, 2);
  assert.match(functionSource('renderSourcePage'), /id === 'bilibili'[\s\S]{0,180}查看已保存字幕/);
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
