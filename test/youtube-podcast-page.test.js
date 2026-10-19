import test from 'node:test';
import assert from 'node:assert/strict';

class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.hidden = false;
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this._html = '';
    this.listeners = {};
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  set innerHTML(value) { this._html = String(value); }
  get innerHTML() { return this._html; }
}

globalThis.document = { createElement: (tag) => new El(tag) };

const { renderYoutubePodcasts } = await import('../apps/web/public/youtube-podcasts.js');

function findAll(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  for (const child of node.children || []) findAll(child, predicate, found);
  return found;
}

test('ready article renders markdown and pending text is marked', async () => {
  const episodes = {
    readyvid0001: { body: '## 股权供给（00:00:03）\n\nBen Inker：市场会差 24%。', articleStatus: 'ready' },
    pendvid00001: { body: '[00:00:03] In general, the market does about 4% worse per percent.', articleStatus: 'pending' },
  };
  const root = new El('div');
  renderYoutubePodcasts(root, {
    api: async (url) => {
      const id = String(url).split('/').pop();
      if (episodes[id]) return { episode: episodes[id] };
      return {
        enabled: true,
        creators: [{
          id: 'odd-lots',
          name: 'Odd Lots',
          focus: '金融',
          episodes: [
            { videoId: 'readyvid0001', title: '奇谈：唐·威尔逊', articleStatus: 'ready', summary: '中文摘要', sourceUrl: 'https://www.youtube.com/watch?v=readyvid0001', publishedAt: Date.parse('2026-10-18T00:00:00Z'), durationSec: 4200, transcriptSource: 'subtitle-auto' },
            { videoId: 'pendvid00001', title: '待整理的一集', articleStatus: 'pending', summary: '中文摘要', sourceUrl: 'https://www.youtube.com/watch?v=pendvid00001', publishedAt: Date.parse('2026-10-17T00:00:00Z'), durationSec: 3600, transcriptSource: 'subtitle-auto' },
          ],
        }],
      };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const titles = findAll(root, (node) => node.className === 'podcast-episode-title');
  assert.equal(titles.length, 2);
  assert.match(titles[1].children.find((node) => node.tagName === 'small').textContent, /待整理/);
  for (const title of titles) await title.listeners.click();
  const buttons = findAll(root, (node) => node.textContent === '展开全文');
  assert.equal(buttons.length, 2);
  for (const button of buttons) await button.listeners.click();
  const article = findAll(root, (node) => node.className === 'podcast-article')[0];
  assert.match(article.innerHTML, /<h3>/);
  assert.match(article.innerHTML, /股权供给/);
  assert.equal(article.textContent.includes('[00:00:03]'), false);
  const pending = findAll(root, (node) => node.className === 'podcast-pending')[0];
  assert.equal(pending.textContent, '待整理');
  const plain = findAll(root, (node) => node.className === 'podcast-transcript-text')[0];
  assert.match(plain.textContent, /worse per percent/);
});
