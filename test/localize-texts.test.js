import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectLocalizationUnits,
  localizationItemId,
  needsZhLocalization,
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
