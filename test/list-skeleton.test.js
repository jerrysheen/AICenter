import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createListSkeleton, paintHubTickSkeleton, paintListSkeleton } from '../apps/web/public/list-skeleton.js';

function mockDocument() {
  function create(tag) {
    const node = {
      tag,
      className: '',
      attrs: {},
      dataset: {},
      children: [],
      ownerDocument: null,
      setAttribute(key, value) { this.attrs[key] = String(value); },
      removeAttribute(key) { delete this.attrs[key]; },
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      get childElementCount() { return this.children.length; },
    };
    node.ownerDocument = document;
    return node;
  }
  const document = { createElement: create };
  return document;
}

test('a list skeleton keeps its height when painted twice', () => {
  const document = mockDocument();
  const root = document.createElement('div');
  const first = paintListSkeleton(root, { rows: 6, label: '正在读取内容…' });
  const second = paintListSkeleton(root, { rows: 6, label: '正在读取内容…' });
  assert.equal(second, first);
  assert.equal(root.childElementCount, 1);
  assert.equal(root.attrs['aria-busy'], 'true');
  assert.equal(first.attrs['aria-label'], '正在读取内容…');
  assert.equal(first.children[0].children.length, 6);
  assert.equal(first.children[0].children[0].children[0].className, 'list-skeleton-title');
  assert.equal(first.children[0].children[0].children[1].className, 'list-skeleton-meta');
});

test('a different row count replaces the skeleton', () => {
  const document = mockDocument();
  const root = document.createElement('div');
  paintListSkeleton(root, { rows: 4 });
  const next = paintListSkeleton(root, { rows: 8 });
  assert.equal(next.dataset.rows, '8');
  assert.equal(createListSkeleton(document, { rows: 2 }).children[0].children.length, 2);
});

test('a feed skeleton is not reused as a short list', () => {
  const document = mockDocument();
  const root = document.createElement('div');
  const feed = paintListSkeleton(root, { rows: 6, label: '搜索中…', variant: 'feed' });
  assert.match(feed.className, /is-feed/);
  assert.match(feed.children[0].children[0].className, /is-feed/);
  const again = paintListSkeleton(root, { rows: 6, label: '正在读取内容…', variant: 'feed' });
  assert.equal(again, feed);
  assert.equal(feed.attrs['aria-label'], '正在读取内容…');
  const replaced = paintListSkeleton(root, { rows: 6, label: '正在读取' });
  assert.notEqual(replaced, feed);
  assert.equal(replaced.className.includes('is-feed'), false);
});

test('feed skeletons stay at a two-line row and brief skeletons match a three-line row', () => {
  const html = readFileSync(new URL('../apps/web/public/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../apps/web/public/styles.css', import.meta.url), 'utf8');
  assert.match(html, /id="report-list"[\s\S]*list-skeleton is-feed/);
  assert.match(css, /\.feed > \.list-skeleton \.list-skeleton-row,\s*\.list-skeleton\.is-feed \.list-skeleton-row \{\s*box-sizing: border-box;\s*min-height: 112px;/);
  assert.match(css, /#report-list \.list-skeleton\.is-feed \.list-skeleton-row,\s*\.tree-list \.list-skeleton\.is-feed \.list-skeleton-row,\s*\.tree-hour-skeleton \.list-skeleton\.is-feed \.list-skeleton-row \{\s*min-height: 160px;/);
  assert.match(css, /#report-list \.tree-list \.tree-hour-skeleton \.list-skeleton\.is-feed \.list-skeleton-row,\s*#report-list > \.tree-hour-skeleton\.is-page \.list-skeleton\.is-feed \.list-skeleton-row \{\s*min-height: 150px;/);
  assert.match(css, /#report-list \.list-skeleton\.is-feed \.list-skeleton-title,\s*\.tree-list \.list-skeleton\.is-feed \.list-skeleton-title,\s*\.tree-hour-skeleton \.list-skeleton\.is-feed \.list-skeleton-title \{ height: 72px; \}/);
  assert.match(css, /\.tree-hour-skeleton\.is-page \{ display: block; gap: 0; padding: 0; \}/);
  assert.match(css, /\.southbound-daily-line \{[\s\S]*?min-height: calc\(22px \+ 2 \* var\(--space-3\)\);/);
  assert.match(css, /@media \(max-width: 720px\) \{\s*\.southbound-daily-line,\s*\.daily-research > \.southbound-daily-line \{\s*min-height: calc\(44px \+ 2 \* var\(--space-3\)\);\s*\}/);
  assert.match(css, /\.news-row-summary\.is-search-excerpt \{/);
});

test('quote ticks stay skeleton until replaced', () => {
  const document = mockDocument();
  const root = document.createElement('div');
  paintHubTickSkeleton(root, 4);
  const first = root.children[0];
  paintHubTickSkeleton(root, 4);
  assert.equal(root.children[0], first);
  assert.equal(root.childElementCount, 4);
  assert.equal(first.className, 'hub-tick is-skeleton');
  assert.equal(first.children.length, 3);
});

test('first paint and feed boot reserve skeleton slots', () => {
  const html = readFileSync(new URL('../apps/web/public/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../apps/web/public/styles.css', import.meta.url), 'utf8');
  const boot = readFileSync(new URL('../apps/web/public/ui-boot.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const author = readFileSync(new URL('../apps/web/public/author-view.js', import.meta.url), 'utf8');
  assert.match(html, /id="feed"[\s\S]*list-skeleton/);
  assert.match(html, /id="home-timeline"[\s\S]*list-skeleton/);
  assert.match(html, /id="home-latest"[\s\S]*list-skeleton/);
  assert.match(html, /id="hub-ticker"[\s\S]*hub-tick is-skeleton/);
  assert.match(html, /id="note-list"[\s\S]*list-skeleton/);
  assert.match(html, /id="knowledge-list"[\s\S]*list-skeleton/);
  assert.match(html, /id="ask-session-list"[\s\S]*list-skeleton/);
  assert.match(css, /\.list-skeleton-row \{/);
  assert.match(css, /html\.feed-boot #view-feed \{ display: block; \}/);
  assert.match(boot, /feed-boot/);
  assert.match(app, /paintListSkeleton\(elements\.feed/);
  assert.match(app, /!state\.notesLoaded/);
  assert.match(author, /className = 'list-skeleton'/);
});
