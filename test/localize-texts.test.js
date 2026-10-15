import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectLocalizationUnits,
  localizationItemId,
  needsZhLocalization,
  translationLooksTruncated,
} from '../packages/domain/src/localize-texts.js';

test('needsZhLocalization matches the feed translation heuristic', () => {
  assert.equal(needsZhLocalization('今天市场整体偏强，沪深成交额放大。'), false);
  assert.equal(needsZhLocalization('NVIDIA announced a new HBM partnership.'), true);
  assert.equal(needsZhLocalization('SK하이닉스가 HBM 생산능력을 확대할 계획이라고 밝혔다.'), true);
});

test('needsZhLocalization keeps Chinese posts that only mix in English product names', () => {
  assert.equal(needsZhLocalization('卧槽，Python 画 K 线直接上 TradingView 同款图表库，它就是 lightweight-charts-python。'), false);
  assert.equal(needsZhLocalization('推荐一个挺硬核的开源量化项目：stock，作者直接把量化交易代码扔 GitHub 了。'), false);
  assert.equal(needsZhLocalization('强烈建议大家都亲自试试Jev，能让你的Codex操作速度提高10倍并省下大量token！'), false);
  assert.equal(needsZhLocalization('The latest AI Spotlight explores QwenWork International.'), true);
  const longEnglish = `${'English report '.repeat(400)}长鑫存储扩产计划已经公开说明`;
  assert.equal(longEnglish.length > 280, true);
  assert.equal(needsZhLocalization(longEnglish), true);
});

test('translationLooksTruncated uses length ratio and a cut ending', () => {
  const latin = 'Capacity plan remains uncertain. '.repeat(16);
  assert.ok(latin.length >= 500);
  assert.equal(translationLooksTruncated(latin, 40), true);
  assert.equal(translationLooksTruncated(latin, 200), false);
  assert.equal(translationLooksTruncated('A short post.', 4), false);
  const jeff = latin.slice(0, 420);
  assert.ok(jeff.length < 600);
  assert.equal(translationLooksTruncated(jeff, 28, '…缺乏公开信息（我...'), true);
  assert.equal(translationLooksTruncated('The source itself ends with an ellipsis…', 18, '原文自己就用了省略号…'), false);
  const han = '这是一段中文原文，只是为了测量汉字密度。'.repeat(20);
  assert.equal(translationLooksTruncated(han, 40), true);
  assert.equal(translationLooksTruncated(han, 400), false);
  assert.equal(translationLooksTruncated(jeff, jeff.length, `${'译文已经写完。'.repeat(40)}`), false);
  const notice = 'SCIO holds a press conference on the economic situation.';
  assert.ok(notice.length < 80);
  assert.equal(translationLooksTruncated(notice, 16, '国新办就经济形势举行新闻发布会'), false);
  const title = 'The State Council Information Office will hold a press conference on the current economic situation.';
  const titled = '国务院新闻办公室将就当前经济形势举行新闻发布会并回答提问';
  assert.ok(title.length > 80 && title.length < 160);
  assert.ok(titled.length * 4 >= title.length);
  assert.equal(translationLooksTruncated(title, titled.length, titled), false);
  assert.equal(translationLooksTruncated(notice, 8, '国新办通知…'), true);
  const headline = 'Microsoft denies cloud leadership asked suppliers to cut prices this week after the earnings call';
  assert.ok(headline.length > 80 && headline.length <= 240 && !headline.includes('\n'));
  assert.equal(translationLooksTruncated(headline, 18, '微软否认云业务领导层曾要求供应商降价'), false);
});

test('localizationItemId hashes identifiers longer than 128 characters', () => {
  assert.equal(localizationItemId('bls-nfp'), 'bls-nfp');
  const longId = `event:${'a'.repeat(200)}`;
  assert.match(localizationItemId(longId), /^h:[0-9a-f]{64}$/);
});

test('collectLocalizationUnits reads events, releases and prediction questions', () => {
  const units = collectLocalizationUnits({
    upcoming: [{ eventId: 'e1', title: 'Employment Situation' }],
    releases: [{ releaseId: 'r1', title: 'Executive Order on chips' }],
    predictionMarkets: [{ quoteId: 'q1', marketQuestion: 'Will Fed cut in March?' }],
  });
  assert.deepEqual(units.map((unit) => unit.id), ['e1', 'r1', 'q1']);
  assert.equal(units[2].text, 'Will Fed cut in March?');
});
