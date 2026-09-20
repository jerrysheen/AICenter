import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const html = readFileSync(path.join('apps', 'web', 'public', 'index.html'), 'utf8');
const css = readFileSync(path.join('apps', 'web', 'public', 'styles.css'), 'utf8');

test('ask session keeps records, thread and composer in one shell', () => {
  assert.match(html, /id="view-ask"[\s\S]*id="ask-records"[\s\S]*id="ask-session-shell"[\s\S]*id="ask-thread"[\s\S]*id="ask-form"/);
  assert.match(css, /--ask-column:\s*800px/);
  assert.match(css, /\.ask-records \{[\s\S]*max-width:\s*var\(--ask-column\)/);
  assert.match(css, /\.ask-shell \{[\s\S]*max-width:\s*var\(--ask-column\)/);
  assert.match(css, /\.ask-shell \{[\s\S]*margin-inline:\s*auto/);
});

test('ask session uses a viewport column; composer stays in-flow on desktop', () => {
  assert.match(css, /body\[data-view="ask"\]\[data-ask-layer="session"\] \.ask-thread \{[\s\S]*overflow-y:\s*auto/);
  assert.match(css, /body\[data-view="ask"\]\[data-ask-layer="session"\] \.ask-composer \{[\s\S]*position:\s*static/);
  assert.match(css, /@media \(max-width:\s*699px\) \{[\s\S]*\.ask-composer \{[\s\S]*position:\s*fixed/);
  assert.doesNotMatch(css, /\.ask-composer,\s*\.ask-shell \{ max-width: 720px; \}/);
  assert.doesNotMatch(css, /body\[data-view="ask"\]\[data-ask-layer="session"\] \.ask-composer \.compose-box,[\s\S]*max-width:\s*720px/);
});
