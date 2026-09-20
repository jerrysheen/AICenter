import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const html = readFileSync(path.join('apps', 'web', 'public', 'index.html'), 'utf8');
const css = readFileSync(path.join('apps', 'web', 'public', 'styles.css'), 'utf8');
const js = readFileSync(path.join('apps', 'web', 'public', 'app.js'), 'utf8');

test('ask research mode uses a HarmonyOS switch in the composer tools group', () => {
  assert.match(html, /class="ask-composer-tools"/);
  assert.match(html, /class="ask-research-mode"/);
  assert.match(html, /class="ask-research-switch"/);
  assert.match(html, /class="ask-research-label">专业研究</);
  assert.match(html, /input class="vh"[^>]*name="researchMode"[^>]*role="switch"/);
  assert.doesNotMatch(html, /<label class="ask-research-mode">\s*<input type="checkbox"/);
});

test('ask composer has an agent selector that includes 文章阅读', () => {
  assert.match(html, /class="ask-agent-mode"/);
  assert.match(html, /select name="agentMode"/);
  assert.match(html, /<option value="article-analysis">文章阅读<\/option>/);
  assert.match(css, /body\[data-agent-mode="article-analysis"\] \.ask-research-mode/);
  assert.match(js, /function currentAgentMode/);
  assert.match(js, /function askArticleAnalysis/);
  assert.match(js, /function formatArticleProgressText/);
  assert.match(js, /renderMarkdownInto\(answer, record\.outputText/);
  assert.match(js, /\/api\/v1\/article-analysis\/runs/);
  assert.match(js, /正在阅读材料/);
  assert.doesNotMatch(js, /正在判断材料类型/);
  assert.doesNotMatch(js, /article-analysis-json/);
});

test('ask research switch uses token-sized track and brand selected state', () => {
  assert.match(css, /\.ask-research-mode \{[\s\S]*min-height:\s*40px/);
  assert.match(css, /\.ask-research-switch \{[\s\S]*width:\s*36px/);
  assert.match(css, /\.ask-research-switch \{[\s\S]*height:\s*20px/);
  assert.match(css, /\.ask-research-mode:has\(input:checked\) \.ask-research-switch \{[\s\S]*background:\s*var\(--brand\)/);
  assert.match(css, /transition:\s*background 150ms var\(--motion\)/);
  assert.match(js, /function syncResearchModeSwitch/);
});
