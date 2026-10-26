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
  setAttribute(name, value) { this[name] = String(value); }
  set innerHTML(value) { this._html = String(value); }
  get innerHTML() { return this._html; }
}

globalThis.document = {
  createElement: (tag) => new El(tag),
  createTextNode: (text) => Object.assign(new El('#text'), { textContent: String(text) }),
};

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
  renderPodcastLibrary,
  renderPodcastReader,
  podcastReaderFloatVisibility,
  podcastStatusLabel,
} = await import(pathToFileURL(path.join(pageDir, 'youtube-podcasts.js')).href);
process.on('exit', () => rmSync(pageDir, { recursive: true, force: true }));

function findAll(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  for (const child of node.children || []) findAll(child, predicate, found);
  return found;
}

function textOf(node) {
  const own = node.children?.length ? (node.textContent || '') : `${node.textContent || ''}${node.innerHTML || ''}`;
  return `${own}${(node.children || []).map(textOf).join('')}`;
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
  }), '');
  assert.equal(partialArticleLabel({ text: '主持人：已经译出的一段。', remaining: 4 }), '未完整 · 还剩 4 段');
  assert.equal(
    partialArticleLabel(
      { text: '主持人：已经译出的一段。', remaining: 4 },
      '已译 24/28 段，模型服务暂时出错，明天 00:10 继续',
    ),
    '未完整 · 还剩 4 段，明天 00:10 继续',
  );
  const partialRoot = new El('div');
  appendPartialArticle(partialRoot, { text: '## 开场\n\n主持人：已经译出的一段。', remaining: 4 });
  assert.equal(partialRoot.children[0].textContent, '未完整 · 还剩 4 段');
  assert.match(partialRoot.children[1].innerHTML, /已经译出的一段/);
  assert.equal(youtubeReaderScopeLabel({ id: 'youtube:2Zj6uMv3kTA', platform: 'youtube' }, { articleStatus: 'ready' }), '正文完整');
  assert.equal(youtubeReaderScopeLabel({ id: 'media:1', platform: 'media', complete: false, bodyScope: '仅摘要' }, null), null);
  assert.equal(YOUTUBE_ARTICLE_POLL_SLOW_MS >= 3 * 60 * 1000, true);
});

function zonePayload() {
  return {
    enabled: true,
    creators: [
      {
        id: 'odd-lots',
        name: 'Odd Lots',
        followed: true,
        episodes: [
          {
            videoId: 'oldervid0001',
            title: '较早的一集',
            creatorName: 'Odd Lots',
            publishedAt: Date.parse('2026-10-17T01:00:00Z'),
            durationSec: 3600,
            status: 'ready',
            transcriptSource: 'subtitle-auto',
            articleStatus: 'pending',
            article: { status: 'queued', message: '中文整理排队中' },
            isRead: true,
          },
          {
            videoId: 'readyvid0001',
            title: '已经整理的一集',
            creatorName: 'Odd Lots',
            publishedAt: Date.parse('2026-10-18T01:00:00Z'),
            durationSec: 4200,
            status: 'ready',
            transcriptSource: 'subtitle-auto',
            articleStatus: 'ready',
            article: { status: 'ready' },
            isRead: false,
            body: '## 要点\n\n主持人：正文。',
          },
        ],
      },
      {
        id: 'all-in',
        name: 'All-In',
        followed: false,
        episodes: [
          {
            videoId: 'failedvid001',
            title: '还没有字幕',
            creatorName: 'All-In',
            publishedAt: Date.parse('2026-10-19T01:00:00Z'),
            durationSec: 1800,
            status: 'failed',
            isRead: false,
          },
          {
            videoId: 'speedvid0001',
            title: '可以速读',
            creatorName: 'All-In',
            publishedAt: Date.parse('2026-10-16T01:00:00Z'),
            durationSec: 7200,
            status: 'ready',
            transcriptSource: 'subtitle-auto',
            articleStatus: 'ready',
            article: { status: 'ready' },
            speedRead: { status: 'ready', text: '三句话讲完。' },
            isRead: false,
          },
        ],
      },
    ],
  };
}

test('podcast zone lists episodes newest first with honest status and keeps read rows', () => {
  const payload = zonePayload();
  assert.deepEqual(podcastStatusLabel(payload.creators[1].episodes[0]), '视频待整理');
  assert.equal(podcastStatusLabel(payload.creators[0].episodes[1]), '已整理');
  assert.equal(podcastStatusLabel(payload.creators[0].episodes[0]), '整理中');
  assert.equal(podcastStatusLabel(payload.creators[1].episodes[1]), '速读可用');
  const root = new El('div');
  let opened = '';
  let more = 0;
  renderPodcastLibrary(root, {
    payload,
    shown: 2,
    now: Date.parse('2026-10-19T08:00:00Z'),
    onOpen: (episode) => { opened = episode.videoId; },
    onMore: () => { more += 1; },
  });
  const titles = findAll(root, (node) => node.className === 'news-row-title').map((node) => node.textContent);
  assert.deepEqual(titles, ['还没有字幕', '已经整理的一集']);
  const sources = findAll(root, (node) => node.className === 'news-row-source').map((node) => node.textContent);
  assert.match(sources[0], /All-In · 30分钟 · 视频待整理/);
  assert.match(sources[1], /Odd Lots · 1小时10分钟 · 已整理/);
  const rows = findAll(root, (node) => node.className?.startsWith('news-row'));
  assert.equal(rows.some((row) => row.className.includes('is-muted')), false);
  findAll(root, (node) => node.className === 'news-row-body official-event-body feed-content')[0].listeners.click();
  assert.equal(opened, 'failedvid001');
  const moreButton = findAll(root, (node) => node.textContent === '加载更多')[0];
  moreButton.listeners.click();
  assert.equal(more, 1);
  renderPodcastLibrary(root, { payload, now: Date.parse('2026-10-19T08:00:00Z') });
  const allRows = findAll(root, (node) => node.className === 'news-row' || node.className === 'news-row is-muted');
  assert.equal(allRows.length, 4);
  assert.equal(allRows.some((row) => row.className.includes('is-muted') && row.dataset.videoId === 'oldervid0001'), true);
  assert.equal(findAll(root, (node) => node.textContent === '加载更多').length, 0);
});

test('podcast channel pane keeps followed channels first and filters episodes', () => {
  const payload = zonePayload();
  const root = new El('div');
  let channel = '';
  renderPodcastLibrary(root, { payload, pane: 'channels', onChannel: (id) => { channel = id; } });
  const names = findAll(root, (node) => node.tagName === 'strong').map((node) => node.textContent);
  assert.equal(names[0], 'Odd Lots');
  assert.equal(findAll(root, (node) => node.textContent === '已关注').length, 1);
  const channelButtons = findAll(root, (node) => node.tagName === 'button' && /^podcast-channel( |$)/.test(node.className));
  channelButtons[1].listeners.click();
  assert.equal(channel, 'all-in');
  renderPodcastLibrary(root, { payload, channel: 'odd-lots' });
  const titles = findAll(root, (node) => node.className === 'news-row-title').map((node) => node.textContent);
  assert.deepEqual(titles, ['已经整理的一集', '较早的一集']);
  renderPodcastLibrary(root, { payload: { enabled: false, creators: [] } });
  assert.match(textOf(root), /播客还没打开/);
  renderPodcastLibrary(root, { payload: { enabled: true, creators: [] } });
  assert.match(textOf(root), /还没有播客单集/);
});

test('podcast reader keeps the speed switch and does not call an unfinished article complete', () => {
  const payload = zonePayload();
  const pending = payload.creators[0].episodes[0];
  const ready = payload.creators[0].episodes[1];
  const failed = payload.creators[1].episodes[0];
  const speed = payload.creators[1].episodes[1];
  const root = new El('div');
  let mode = '';
  let back = 0;
  renderPodcastReader(root, {
    episode: pending,
    mode: 'speed',
    onMode: (next) => { mode = next; },
    onBack: () => { back += 1; },
  });
  assert.match(textOf(root), /速读整理中/);
  assert.equal(textOf(root).includes('正文完整'), false);
  assert.equal(findAll(root, (node) => node.textContent === '速读版').length, 2);
  assert.equal(findAll(root, (node) => node.textContent === '全文').length, 2);
  const floatBar = findAll(root, (node) => node.className === 'podcast-reader-float')[0];
  assert.equal(floatBar['aria-hidden'], 'true');
  assert.equal(floatBar.className.includes('is-shown'), false);
  assert.equal(textOf(floatBar).includes('打开 YouTube'), false);
  assert.match(textOf(floatBar), /较早的一集/);
  assert.equal(findAll(floatBar, (node) => node.textContent === '速读版').length, 1);
  findAll(root, (node) => node.textContent === '‹ 返回')[0].listeners.click();
  assert.equal(back, 1);
  findAll(root, (node) => node.textContent === '全文')[0].listeners.click();
  assert.equal(mode, 'full');
  renderPodcastReader(root, { episode: failed, mode: 'full' });
  assert.match(textOf(root), /视频待整理/);
  assert.equal(textOf(root).includes('正文完整'), false);
  assert.equal(findAll(root, (node) => node.className === 'podcast-article').length, 0);
  const link = findAll(root, (node) => node.textContent === '打开 YouTube ↗')[0];
  assert.equal(link.href, 'https://www.youtube.com/watch?v=failedvid001');
  renderPodcastReader(root, { episode: ready, mode: 'full' });
  assert.match(findAll(root, (node) => node.className === 'podcast-article')[0].innerHTML, /主持人/);
  assert.equal(textOf(root).includes('正文完整'), false);
  renderPodcastReader(root, { episode: speed, mode: 'speed' });
  assert.match(textOf(root), /三句话讲完/);
  assert.equal(textOf(root).includes('速读整理中'), false);
  renderPodcastReader(root, {
    episode: {
      ...ready,
      body: '## 要点\n\n- **利率**会差 24%。\n\n## 利率路径（00:12:03）\n\n市场认为路径变了。\n\n> 这一句是原话。',
    },
    mode: 'full',
  });
  const rich = findAll(root, (node) => node.className === 'podcast-article')[0].innerHTML;
  assert.match(rich, /<strong>利率<\/strong>/);
  assert.match(rich, /<ul>/);
  assert.match(rich, /<blockquote>/);
  assert.match(rich, /<h3>/);
  assert.equal(podcastReaderFloatVisibility({ previousY: 0, nextY: 20, shown: false, narrow: true, revealAfter: 180 }), false);
  assert.equal(podcastReaderFloatVisibility({ previousY: 80, nextY: 420, shown: false, narrow: true, revealAfter: 180 }), false);
  assert.equal(podcastReaderFloatVisibility({ previousY: 420, nextY: 360, shown: false, narrow: true, revealAfter: 180 }), true);
  assert.equal(podcastReaderFloatVisibility({ previousY: 360, nextY: 362, shown: true, narrow: true, revealAfter: 180 }), true);
  assert.equal(podcastReaderFloatVisibility({ previousY: 360, nextY: 100, shown: true, narrow: true, revealAfter: 180 }), false);
  assert.equal(podcastReaderFloatVisibility({ previousY: 420, nextY: 300, shown: false, narrow: false, revealAfter: 180 }), false);
});
