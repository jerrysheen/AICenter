import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentTraceLog, projectAgentProgress } from '../packages/runtime/src/agent-trace-log.js';

test('agent trace log appends reviewable local records and redacts secrets', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-trace-'));
  try {
    const trace = createAgentTraceLog({ dataDirectory: directory, now: () => Date.UTC(2026, 8, 16) });
    const filePath = await trace.append({
      runId: 'run-1', workspaceId: 'local', event: 'tool.completed',
      detail: { data: { title: '半导体', apiKey: 'must-not-appear' }, refs: [] },
    });
    const record = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.equal(record.event, 'tool.completed');
    assert.equal(record.detail.data.apiKey, '[redacted]');
    assert.equal(record.detail.data.title, '半导体');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('agent trace log projects compact progress steps without tool payloads', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-trace-'));
  try {
    const trace = createAgentTraceLog({ dataDirectory: directory });
    await trace.append({ runId: 'run-2', event: 'model.requested', detail: { round: 0 } });
    await trace.append({
      runId: 'run-2', event: 'model.responded',
      detail: { round: 0, toolCalls: [{ name: 'holdings_get', args: { hidden: true } }] },
    });
    const steps = await trace.listSteps('run-2');
    assert.equal(steps[0].label, '正在判断这一轮要读取什么');
    assert.equal(steps[1].label, '准备读取当前持仓');
    assert.equal(steps[1].status, 'done');
    const withQuery = projectAgentProgress([
      {
        at: 2, event: 'model.responded',
        detail: { round: 0, toolCalls: [{ name: 'feed_search', args: { query: '科创板为什么涨这么多 半导体设备' } }] },
      },
      {
        at: 3, event: 'tool.completed',
        detail: {
          id: 'feed.search', callId: 'c1',
          input: { query: '科创板为什么涨这么多 半导体设备' },
          data: [{ title: '华正新材中报后继续跟踪 ABF 与覆铜板景气度，板块波动仍大但个股走出独立行情。' }],
        },
      },
    ]);
    assert.equal(withQuery[0].detail, '信息流：科创板为什么涨这么多 半导体设备');
    assert.equal(withQuery[1].detail.length <= 101, true);
    assert.match(withQuery[1].detail, /华正新材/);
    const projected = projectAgentProgress([
      { at: 3, event: 'tool.batch.skipped', detail: { requested: ['feed_search'] } },
    ]);
    assert.equal(projected[0].label, '工具预算已满，改为根据已有结果作答');
    assert.equal(projected[0].detail, '未执行：信息流');
    const rejected = projectAgentProgress([
      {
        at: 4, event: 'model.requested',
        detail: { round: 0, visibleToolIds: ['feed.search', 'web.search'] },
      },
      {
        at: 5, event: 'model.responded',
        detail: { round: 0, toolCalls: [], answerPreview: '今天没有加息' },
      },
      {
        at: 6, event: 'answer.rejected',
        detail: { round: 0, reason: 'fabricated-web-search', answerPreview: '我联网查到今天没有加息' },
      },
    ]);
    assert.equal(rejected[0].label, '正在判断这一轮要读取什么');
    assert.equal(rejected[1].label, '正在整理回答');
    assert.equal(rejected[1].detail, '今天没有加息');
    assert.equal(rejected[2].label, '回答未采纳，来源声称与 Tool 调用不符');
    const tagHit = projectAgentProgress([
      {
        at: 8, event: 'model.responded',
        detail: { round: 0, toolCalls: [{ name: 'feed_tag_search', args: { tag: '算力', timeRange: 'today' } }] },
      },
      {
        at: 9, event: 'tool.started',
        detail: { id: 'feed.tag.search', callId: 't1', input: { tag: '算力', timeRange: 'today' } },
      },
      {
        at: 10, event: 'tool.completed',
        detail: {
          id: 'feed.tag.search', callId: 't1',
          input: { tag: '算力', timeRange: 'today' },
          data: { matchedCount: 9, items: [{ title: '昇腾 960' }] },
        },
      },
    ]);
    assert.equal(tagHit[0].label, '准备读取Tag 信息流');
    assert.equal(tagHit[1].label, '已读取 Tag 信息流 · 命中 9 条');
    const searchHit = projectAgentProgress([
      {
        at: 7, event: 'tool.completed',
        detail: {
          id: 'web.search', callId: 's1',
          input: { query: 'Federal Reserve FOMC September 16 2026' },
          data: { query: 'Federal Reserve FOMC September 16 2026', results: [{ title: 'Fed holds rates' }] },
        },
      },
    ]);
    assert.equal(searchHit[0].label, '已获取联网结果');
    assert.match(searchHit[0].detail, /Fed holds rates/);
    const gated = projectAgentProgress([
      {
        at: 20, event: 'evidence.gate.started',
        detail: { id: 'web.search', callId: 'g1', resultCount: 8, query: 'CIOE NPO' },
      },
      {
        at: 21, event: 'evidence.gate.completed',
        detail: { id: 'web.search', callId: 'g1', acceptedCount: 3, rejectedCount: 5, confidence: 0.84, sufficiency: 0.91 },
      },
    ]);
    assert.equal(gated[0].label, '已筛查检索结果 · 采用 3');
    assert.equal(gated[0].status, 'done');
    assert.match(gated[0].detail, /筛掉 5/);
    const auxiliary = projectAgentProgress([
      { at: 8, event: 'auxiliary.started', detail: { query: 'FOMC' } },
      { at: 9, event: 'auxiliary.merged', detail: { chars: 12 } },
    ]);
    assert.equal(auxiliary[0].label, '已并入补充资讯');
    assert.equal(auxiliary[0].status, 'done');
    const article = projectAgentProgress([
      { at: 10, event: 'article.started', detail: { sourceType: 'inline', chars: 1637, title: 'JEV' } },
      { at: 11, event: 'article.stage', detail: { stage: 'running', label: '开始阅读材料' } },
      { at: 12, event: 'article.wait', detail: { stage: 'running', label: '模型正在生成 · 已等待 10 秒', elapsedMs: 10_000 } },
      { at: 13, event: 'model.requested', detail: { round: 0 } },
      { at: 14, event: 'article.completed', detail: {} },
    ]);
    assert.equal(article[0].label, '开始分析材料');
    assert.match(article[0].detail, /1,?637 字/);
    assert.equal(article[1].label, '开始阅读材料');
    assert.match(article[1].detail, /已等待 10 秒/);
    assert.equal(article[3].label, '分析已完成');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('agent trace log can live in the instance runtime directory', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-runtime-trace-'));
  try {
    const logDirectory = path.join(directory, 'runtime', 'logs');
    const trace = createAgentTraceLog({ logDirectory, now: () => Date.UTC(2026, 8, 17) });
    const filePath = await trace.append({ runId: 'run-runtime', event: 'run.started' });
    assert.equal(path.dirname(filePath), path.join(logDirectory, 'agent-runs'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
