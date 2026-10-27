import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

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
  podcastMarkdownSlices,
  podcastReaderFloatVisibility,
  podcastStatusLabel,
  podcastExitAction,
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
  let exited = 0;
  renderPodcastReader(root, {
    episode: pending,
    mode: 'speed',
    onMode: (next) => { mode = next; },
    onBack: () => { back += 1; },
    onExit: () => { exited += 1; },
  });
  assert.match(textOf(root), /速读整理中/);
  assert.equal(textOf(root).includes('正文完整'), false);
  assert.equal(findAll(root, (node) => node.textContent === '速读版').length, 2);
  assert.equal(findAll(root, (node) => node.textContent === '全文').length, 2);
  const floatBar = findAll(root, (node) => node.className === 'podcast-reader-float')[0];
  assert.equal(floatBar['aria-hidden'], 'true');
  assert.equal(floatBar.className.includes('is-shown'), false);
  assert.equal(textOf(floatBar).includes('打开 YouTube'), false);
  assert.equal(textOf(floatBar).includes('退出'), false);
  assert.equal(textOf(floatBar).includes('返回播客'), false);
  assert.match(textOf(floatBar), /较早的一集/);
  assert.equal(findAll(floatBar, (node) => node.textContent === '速读版').length, 1);
  const exitBar = findAll(root, (node) => node.className === 'reader-mobile-bar is-quad')[0];
  assert.equal(exitBar.dataset.podcastChrome, 'exit');
  assert.equal(exitBar.className.includes('podcast-reader-exit'), false);
  const exitButton = findAll(exitBar, (node) => node.tagName === 'button')[0];
  assert.equal(exitButton.tagName, 'button');
  assert.equal(exitButton.className, 'is-back');
  assert.match(exitButton.innerHTML, /<svg/);
  assert.match(exitButton.innerHTML, /<span>返回播客<\/span>/);
  assert.equal(exitButton.innerHTML.includes('退出'), false);
  assert.equal(exitBar['aria-label'], '阅读操作');
  assert.equal(findAll(root, (node) => String(node.innerHTML || '').includes('退出') || node.textContent === '退出').length, 0);
  exitButton.listeners.click();
  assert.equal(exited, 1);
  assert.equal(back, 0);
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
  const tocButtons = findAll(root, (node) => node.className === 'podcast-toc-link').map((node) => node.textContent);
  assert.deepEqual(tocButtons, ['要点', '利率路径（00:12:03）', '要点', '利率路径（00:12:03）']);
  const tocNav = findAll(root, (node) => node.className === 'podcast-toc')[0];
  assert.equal(tocNav['aria-label'], '章节目录');
  const tocToggle = findAll(root, (node) => node.className === 'podcast-toc-toggle')[0];
  assert.equal(tocToggle.textContent, '目录');
  assert.equal(tocToggle['aria-expanded'], 'false');
  tocToggle.listeners.click();
  const tocSheet = findAll(root, (node) => String(node.className).includes('podcast-toc-sheet'))[0];
  assert.equal(tocSheet.className.includes('is-open'), true);
  assert.equal(tocToggle['aria-expanded'], 'true');
  findAll(tocSheet, (node) => node.textContent === '利率路径（00:12:03）')[0].listeners.click();
  assert.equal(tocSheet.className.includes('is-open'), false);
  assert.equal(findAll(root, (node) => node.className === 'podcast-reader-float')[0].className.includes('is-shown'), false);
  const layout = findAll(root, (node) => node.className === 'podcast-reader-layout')[0];
  assert.equal(String(layout.className).includes('is-toc-open'), false);
  const desktopToc = findAll(root, (node) => node.className === 'podcast-toc-desktop');
  assert.equal(desktopToc.length, 2);
  assert.equal(desktopToc[0].textContent, '目录');
  assert.equal(desktopToc[0]['aria-expanded'], 'false');
  desktopToc[0].listeners.click();
  assert.equal(layout.className.includes('is-toc-open'), true);
  assert.equal(desktopToc[0].textContent, '收起目录');
  assert.equal(desktopToc[1]['aria-expanded'], 'true');
  desktopToc[1].listeners.click();
  assert.equal(layout.className.includes('is-toc-open'), false);
  assert.equal(podcastReaderFloatVisibility({ previousY: 0, nextY: 20, shown: false, narrow: true, revealAfter: 180 }), false);
  assert.equal(podcastReaderFloatVisibility({ previousY: 80, nextY: 420, shown: false, narrow: true, revealAfter: 180 }), false);
  assert.equal(podcastReaderFloatVisibility({ previousY: 420, nextY: 360, shown: false, narrow: true, revealAfter: 180 }), true);
  assert.equal(podcastReaderFloatVisibility({ previousY: 360, nextY: 362, shown: true, narrow: true, revealAfter: 180 }), true);
  assert.equal(podcastReaderFloatVisibility({ previousY: 360, nextY: 100, shown: true, narrow: true, revealAfter: 180 }), false);
  assert.equal(podcastReaderFloatVisibility({ previousY: 420, nextY: 300, shown: false, narrow: false, revealAfter: 180 }), true);
  const css = readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
  const barAt = css.indexOf('.reader-mobile-bar { display: grid;');
  const blockAt = css.lastIndexOf('@media (max-width: 699px)', barAt);
  const narrow = css.slice(blockAt, css.indexOf('@media', blockAt + 10));
  assert.match(narrow, /\.reader-mobile-bar \{[^}]*position:\s*fixed;[^}]*bottom:\s*0;[^}]*border-top:\s*1px solid var\(--comp-tertiary\);[^}]*background:\s*var\(--background-primary\)/);
  assert.match(narrow, /\.reader-mobile-bar\.is-quad \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \}/);
  assert.match(narrow, /\.reader-mobile-bar button \{[^}]*background:\s*transparent;[^}]*color:\s*var\(--brand\);[^}]*min-height:\s*48px;[^}]*font-size:\s*12px/);
  assert.match(narrow, /\.reader-mobile-bar\.is-quad > \.is-back:only-child \{ grid-column: -2 \/ -1; \}/);
  assert.match(narrow, /body\[data-podcast-episode="1"\] \.bottom-tab/);
  assert.match(narrow, /body\[data-podcast-episode="1"\] main \{[^}]*padding-bottom:\s*calc\(80px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /\.reader-mobile-bar \{ display: none; \}/);
  assert.equal(readFileSync(path.join(publicDir, 'youtube-podcasts.js'), 'utf8').includes('podcast-reader-exit'), false);
  assert.doesNotMatch(css, /\.podcast-reader-exit button \{[^}]*background:\s*var\(--brand\)/);
  assert.doesNotMatch(css, /\.podcast-reader-exit \{[^}]*left:\s*var\(--side-nav\)/);
  assert.match(css, /@media \(min-width: 1200px\) \{[^]*?\.podcast-reader-layout\.is-toc-open \.podcast-toc \{[^}]*position:\s*sticky;/);
  assert.equal(css.includes('.podcast-reader-layout:has(.podcast-toc)'), false);
  assert.match(css, /\.podcast-reader-bar \{[^}]*position:\s*static;/);
  assert.match(css, /@media \(min-width: 1200px\) \{[^}]*\.podcast-reader-float \{ left: var\(--side-nav\); \}/);
  assert.match(css, /@media \(max-width: 1199px\) \{[^]*?\.podcast-toc-toggle \{[^}]*position:\s*fixed;/);
  assert.match(css, /@media \(max-width: 720px\) \{[^]*?\.podcast-reader-float \{[^}]*position:\s*fixed;/);
});

test('a long episode paints the header before the article body', () => {
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => {
    frames.push(fn);
    return frames.length;
  };
  try {
    const block = `## 利率路径（00:12:03）\n\n${'市场认为路径变了。'.repeat(500)}\n\n`;
    const body = `${block}${block}## 收束（00:46:12）\n\n最后一句。`;
    assert.ok(body.length >= 6000);
    const slices = podcastMarkdownSlices(body);
    assert.ok(slices.length > 1);
    assert.ok(slices[0].startsWith('##'));
    assert.ok(slices.at(-1).includes('最后一句'));
    const root = new El('div');
    renderPodcastReader(root, {
      episode: { videoId: 'longvid000001', title: '长文一集', articleStatus: 'ready', body },
      mode: 'full',
    });
    assert.match(textOf(root), /长文一集/);
    assert.match(textOf(root), /正在排版正文/);
    assert.equal(findAll(root, (node) => node.className === 'podcast-article').length, 0);
    let guard = 0;
    while (frames.length && guard < 12) {
      guard += 1;
      frames.shift()();
    }
    const article = findAll(root, (node) => node.className === 'podcast-article')[0];
    assert.ok(article);
    assert.match(article.innerHTML, /利率路径/);
    assert.match(article.innerHTML, /最后一句/);
    assert.equal(textOf(root).includes('正在排版正文'), false);
    assert.equal(findAll(root, (node) => node.className === 'podcast-toc-desktop').length, 2);
    assert.equal(findAll(root, (node) => node.className === 'podcast-reader-layout')[0].className.includes('is-toc-open'), false);
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test('podcast exit returns to the list that opened the episode', () => {
  assert.deepEqual(podcastExitAction('#podcasts'), { route: 'podcasts', historyBack: true });
  assert.deepEqual(podcastExitAction('#podcasts?channel=odd-lots'), { route: 'podcasts?channel=odd-lots', historyBack: true });
  assert.deepEqual(podcastExitAction('#podcasts?pane=channels'), { route: 'podcasts?pane=channels', historyBack: true });
  assert.deepEqual(podcastExitAction(''), { route: 'podcasts', historyBack: false });
  assert.deepEqual(podcastExitAction('#feed'), { route: 'podcasts', historyBack: false });
  assert.deepEqual(podcastExitAction('#podcast/abcdefghijk'), { route: 'podcasts', historyBack: false });

  const app = readFileSync(path.resolve('apps/web/public/app.js'), 'utf8');
  const source = app.match(/(?:async )?function leavePodcastEpisode\([^]*?\n\}/);
  assert.ok(source);
  const calls = [];
  const history = { state: { aiCenterPrevious: '#podcasts?channel=odd-lots' }, back() { calls.push('back'); } };
  const state = { trail: ['#podcasts?channel=odd-lots'] };
  const context = vm.createContext({
    history,
    state,
    podcastExitAction,
    setView: (...args) => calls.push(args),
  });
  vm.runInContext(source[0], context);
  context.leavePodcastEpisode();
  assert.deepEqual(calls, ['back']);
  assert.equal(state.trail.length, 0);
  history.state = { aiCenterPrevious: '#feed' };
  state.trail = ['#feed'];
  context.leavePodcastEpisode();
  assert.equal(calls[1][0], 'podcasts');
  assert.equal(calls[1][1].back, true);
  history.state = null;
  state.trail = [];
  context.leavePodcastEpisode();
  assert.equal(calls[2][0], 'podcasts');
  assert.equal(calls[2][1].back, true);
  history.state = null;
  state.trail = ['#podcasts?pane=channels'];
  context.leavePodcastEpisode();
  assert.equal(calls[3][0], 'podcasts?pane=channels');
  assert.equal(calls[3][1].back, true);
  assert.equal(state.trail.length, 0);
  assert.match(app, /function revealPodcastRoute\(/);
  assert.match(app, /podcastEpisodeWaiters\.add\(id\)/);
  assert.match(app, /settlePodcastEpisode\(id\)/);
  assert.match(app, /document\.documentElement\.classList\.remove\('quote-boot', 'feed-boot'\)/);
});
