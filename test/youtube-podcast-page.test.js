import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

const pageDir = mkdtempSync(path.join(os.tmpdir(), 'youtube-page-'));
const publicDir = path.resolve('apps/web/public');
const localImport = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.[^'"]+)['"]/g;

function copyModuleGraph(entry) {
  const seen = new Set();
  const pending = [entry];
  while (pending.length) {
    const relative = pending.pop();
    if (seen.has(relative)) continue;
    seen.add(relative);
    const source = readFileSync(path.join(publicDir, relative), 'utf8').replaceAll('?v=dev', '');
    const destination = path.join(pageDir, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, source);
    for (const match of source.matchAll(localImport)) {
      const specifier = match[1].split(/[?#]/)[0];
      if (!specifier.endsWith('.js')) continue;
      pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)));
    }
  }
}

copyModuleGraph('youtube-podcasts.js');
const {
  renderYoutubePodcasts,
  youtubeArticlePollDelay,
  appendPartialArticle,
  partialArticleLabel,
  youtubeReaderScopeLabel,
  youtubeArticleRequestPath,
  YOUTUBE_ARTICLE_POLL_NEAR_MS,
  YOUTUBE_ARTICLE_POLL_SLOW_MS,
} = await import(pathToFileURL(path.join(pageDir, 'youtube-podcasts.js')).href);
process.on('exit', () => rmSync(pageDir, { recursive: true, force: true }));

function findAll(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  for (const child of node.children || []) findAll(child, predicate, found);
  return found;
}

test('ready article renders markdown and pending text is marked', async () => {
  const episodes = {
    readyvid0001: { body: '## 股权供给（00:00:03）\n\nBen Inker：市场会差 24%。', articleStatus: 'ready' },
    pendvid00001: {
      body: '[00:00:03] In general, the market does about 4% worse per percent.',
      articleStatus: 'pending',
      article: { status: 'queued', message: '中文整理排队中，预计 12:10 处理' },
    },
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
            { videoId: 'pendvid00001', title: '待整理的一集', articleStatus: 'pending', article: { status: 'queued', message: '中文整理排队中，预计 12:10 处理' }, summary: '中文摘要', sourceUrl: 'https://www.youtube.com/watch?v=pendvid00001', publishedAt: Date.parse('2026-10-17T00:00:00Z'), durationSec: 3600, transcriptSource: 'subtitle-auto' },
          ],
        }],
      };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const titles = findAll(root, (node) => node.className === 'podcast-episode-title');
  assert.equal(titles.length, 2);
  const pendingLabel = titles[1].children.find((node) => node.tagName === 'small').textContent;
  assert.match(pendingLabel, /中文整理排队中，预计 12:10 处理/);
  assert.equal(pendingLabel.includes('待整理'), false);
  for (const title of titles) await title.listeners.click();
  const buttons = findAll(root, (node) => node.textContent === '展开全文');
  assert.equal(buttons.length, 2);
  for (const button of buttons) await button.listeners.click();
  const article = findAll(root, (node) => node.className === 'podcast-article')[0];
  assert.match(article.innerHTML, /<h3>/);
  assert.match(article.innerHTML, /股权供给/);
  assert.equal(article.textContent.includes('[00:00:03]'), false);
  const pending = findAll(root, (node) => node.className === 'podcast-pending')[0];
  assert.equal(pending.textContent, '中文整理排队中，预计 12:10 处理');
  const folded = findAll(root, (node) => node.className === 'podcast-original')[0];
  assert.equal(folded.open, false);
  assert.equal(folded.children.find((node) => node.tagName === 'summary').textContent, '英文原文');
  const plain = findAll(folded, (node) => node.className === 'podcast-transcript-text')[0];
  assert.match(plain.textContent, /worse per percent/);
});

test('queued article polls the status path slowly until the expected time is close', () => {
  const now = Date.parse('2026-10-20T02:00:00Z');
  const far = { articleStatus: 'pending', article: { status: 'queued', message: '中文整理排队中，预计 12:10 处理', nextAt: now + 3 * 60 * 60 * 1000 } };
  const near = { articleStatus: 'pending', article: { status: 'queued', message: '预计时间已过，将于 12:10 重试', nextAt: now + 90_000 } };
  const running = { articleStatus: 'pending', article: { status: 'running', message: '整理中 2/9 段', nextAt: now + 3 * 60 * 60 * 1000 } };
  const failed = { articleStatus: 'pending', article: { status: 'failed', message: '整理失败：模型没有整理完这一段，将于 15:10 重试', nextAt: now + 3 * 60 * 60 * 1000 } };
  assert.equal(youtubeArticleRequestPath('pendvid00001'), '/api/v1/youtube-podcasts/pendvid00001/article');
  assert.equal(youtubeArticleRequestPath('pendvid00001', { ready: true }), '/api/v1/youtube-podcasts/pendvid00001');
  assert.equal(youtubeArticlePollDelay(far, now), YOUTUBE_ARTICLE_POLL_SLOW_MS);
  assert.equal(youtubeArticlePollDelay(failed, now), YOUTUBE_ARTICLE_POLL_SLOW_MS);
  assert.equal(youtubeArticlePollDelay(near, now), YOUTUBE_ARTICLE_POLL_NEAR_MS);
  assert.equal(youtubeArticlePollDelay(running, now), YOUTUBE_ARTICLE_POLL_NEAR_MS);
  const paused = { articleStatus: 'pending', article: { status: 'queued', message: '已译 24/28 段，模型服务暂时出错，00:10 继续', nextAt: now + 3 * 60 * 60 * 1000 } };
  const finishing = { articleStatus: 'pending', article: { status: 'running', message: '收尾中', nextAt: now + 3 * 60 * 60 * 1000 } };
  assert.equal(youtubeArticlePollDelay(paused, now), YOUTUBE_ARTICLE_POLL_SLOW_MS);
  assert.equal(youtubeArticlePollDelay(finishing, now), YOUTUBE_ARTICLE_POLL_NEAR_MS);
  assert.equal(youtubeArticlePollDelay({ articleStatus: 'ready', article: { status: 'ready' } }, now), 0);
  assert.equal(youtubeReaderScopeLabel({ id: 'youtube:2Zj6uMv3kTA', platform: 'youtube', complete: false, bodyScope: '仅摘要' }, null), '');
  assert.equal(youtubeReaderScopeLabel({ id: 'youtube:2Zj6uMv3kTA', platform: 'youtube' }, {
    articleStatus: 'pending',
    partial: { text: '主持人：已经译出的一段。', remaining: 4 },
  }), '未完整');
  assert.equal(partialArticleLabel({ text: '主持人：已经译出的一段。', remaining: 4 }), '未完整 · 还剩 4 段');
  const partialRoot = new El('div');
  appendPartialArticle(partialRoot, { text: '## 开场\n\n主持人：已经译出的一段。', remaining: 4 });
  assert.equal(partialRoot.children[0].textContent, '未完整 · 还剩 4 段');
  assert.match(partialRoot.children[1].innerHTML, /已经译出的一段/);
  assert.equal(youtubeReaderScopeLabel({ id: 'youtube:2Zj6uMv3kTA', platform: 'youtube' }, { articleStatus: 'ready' }), '正文完整');
  assert.equal(youtubeReaderScopeLabel({ id: 'media:1', platform: 'media', complete: false, bodyScope: '仅摘要' }, null), null);
  assert.equal(YOUTUBE_ARTICLE_POLL_SLOW_MS >= 3 * 60 * 1000, true);
});
