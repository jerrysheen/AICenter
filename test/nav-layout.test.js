import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../apps/web/public/styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../apps/web/public/index.html', import.meta.url), 'utf8');
const mock = readFileSync(new URL('../apps/web/public/mock.js', import.meta.url), 'utf8');

test('sidebar hover lives in a hover media query and a nav click drops focus', () => {
  assert.match(css, /@media \(hover: hover\) \{\s*\.nav-item:hover \{ background: var\(--interactive-hover\); \}\s*\}/);
  assert.equal(css.match(/\.nav-item:hover/g).length, 1);
  const click = app.slice(app.lastIndexOf("closest('[data-nav]')"));
  assert.match(click.slice(0, 400), /trigger\.blur\(\)/);
});

test('recent scope is labeled 最近浏览 on the overview timeline and the feed channel', () => {
  assert.match(app, /\{ id: 'recent', label: '最近浏览' \}/);
  assert.doesNotMatch(app, /\{ id: 'recent', label: '最近' \}/);
  assert.match(mock, /\{ id: 'recent', label: '最近浏览' \}/);
});

test('overview side column stacks on its own so 官方 is not pushed by the left column', () => {
  const side = html.slice(html.indexOf('overview-col-side'), html.indexOf('overview-catalog'));
  assert.match(side, /home-slot-quotes[\s\S]*home-slot-daily[\s\S]*home-slot-official/);
  assert.match(css, /\.overview-col \{ display: contents; \}/);
  assert.match(css, /@media \(min-width: 700px\) \{[\s\S]*?\.overview-col-side \{ grid-column: 2; \}/);
  assert.doesNotMatch(css, /home-slot-official \{[^}]*grid-row:\s*3/);
});

test('event probability list grows with the page instead of scrolling inside the card', () => {
  assert.match(css, /\.market-native-prediction-panel \.market-native-list \{\s*max-height: none;\s*overflow: visible;\s*\}/);
});

test('inspire back control takes its own row so the page title stays on the reading column', () => {
  assert.match(css, /body\[data-view="inspire"\]:has\(#nav-back:not\(\.hidden\)\) #nav-back \{\s*flex: 1 0 100%;\s*max-width: none;/);
});
