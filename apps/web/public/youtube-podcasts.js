import { renderMarkdownInto } from './markdown.js?v=dev';
import { attachYoutubeHeadingTimes, youtubeWatchUrl } from './youtube-article-links.js?v=dev';
import { clockLabel, dateKey, monthDayLabel } from './shanghai-time.js?v=dev';

const SOURCE_LABEL = {
  'subtitle-manual': '人工字幕',
  'subtitle-auto': '自动字幕',
  'gemini-transcribe': '语音转写',
};

function clock(at) {
  const time = Number(at) || 0;
  if (!time) return '';
  const date = new Date(time);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${month}月${day}日 ${hh}:${mm}`;
}

function minutes(durationSec) {
  const value = Number(durationSec) || 0;
  if (!value) return '';
  return `${Math.round(value / 60)} 分钟`;
}

export const YOUTUBE_ARTICLE_POLL_SLOW_MS = 3 * 60 * 1000;
export const YOUTUBE_ARTICLE_POLL_NEAR_MS = 20_000;
const YOUTUBE_ARTICLE_POLL_NEAR_WINDOW_MS = 2 * 60 * 1000;

export function youtubeArticleRequestPath(videoId, { ready = false } = {}) {
  const id = encodeURIComponent(String(videoId || ''));
  return ready ? `/api/v1/youtube-podcasts/${id}` : `/api/v1/youtube-podcasts/${id}/article`;
}

export function youtubeArticlePollDelay(episode, now = Date.now()) {
  const article = episode?.article;
  if (!episode || article?.status === 'ready' || episode.articleStatus === 'ready') return 0;
  if (article?.status === 'running') return YOUTUBE_ARTICLE_POLL_NEAR_MS;
  const nextAt = Number(article?.nextAt);
  if (Number.isFinite(nextAt) && nextAt > now && nextAt - now <= YOUTUBE_ARTICLE_POLL_NEAR_WINDOW_MS) {
    return YOUTUBE_ARTICLE_POLL_NEAR_MS;
  }
  return YOUTUBE_ARTICLE_POLL_SLOW_MS;
}

export function youtubeReaderScopeLabel(post, episode) {
  const youtube = post?.platform === 'youtube' || /^youtube:/i.test(String(post?.id || ''));
  if (!youtube) return null;
  if (episode?.article?.status === 'ready' || episode?.articleStatus === 'ready') return '正文完整';
  return '';
}

export function articleContinueWhen(message) {
  const value = String(message || '');
  const named = value.match(/明天\s+\d{1,2}(?::\d{2}|点)/);
  if (named) return named[0].replace(/\s+/g, ' ');
  const dated = value.match(/\d{1,2}月\d{1,2}日\s+\d{1,2}(?::\d{2}|点)/);
  if (dated) return dated[0].replace(/\s+/g, ' ');
  const directed = value.match(/(?:将于|预计)\s+(\d{1,2}(?::\d{2}|点))/);
  if (directed) return directed[1];
  const bare = value.match(/(\d{2}:\d{2}|\d{1,2}点)\s+继续/);
  if (bare) return bare[1];
  return '';
}

export function partialArticleLabel(partial, message = '') {
  if (!String(partial?.text || '').trim()) return '';
  const remaining = Number(partial.remaining) || 0;
  const lead = remaining > 0 ? `未完整 · 还剩 ${remaining} 段` : '未完整';
  const when = articleContinueWhen(message);
  return when ? `${lead}，${when} 继续` : lead;
}

export function appendPartialArticle(parent, partial, label = '') {
  const shown = label || partialArticleLabel(partial);
  if (!String(partial?.text || '').trim() || !shown) return false;
  parent.append(Object.assign(document.createElement('p'), {
    className: 'podcast-pending partial-article-label',
    textContent: shown,
  }));
  const article = document.createElement('div');
  article.className = 'podcast-article partial-article';
  renderMarkdownInto(article, partial.text);
  parent.append(article);
  return true;
}

export function episodeArticleMessage(episode) {
  const message = String(episode?.article?.message || '').trim();
  if (message) return message;
  if (episode?.articleStatus === 'pending') return '中文整理排队中';
  return '';
}

export function foldedOriginal(text, label = '英文原文') {
  const details = document.createElement('details');
  details.className = 'podcast-original';
  details.open = false;
  const summary = document.createElement('summary');
  summary.textContent = label;
  const pre = document.createElement('pre');
  pre.className = 'podcast-transcript-text';
  pre.textContent = text || '没有全文。';
  details.append(summary, pre);
  return details;
}

export function renderYoutubePodcasts(root, { api, videoId = '', showToast = () => {} } = {}) {
  root.replaceChildren();
  const page = document.createElement('section');
  page.className = 'podcast-page';
  const head = document.createElement('div');
  head.className = 'podcast-head';
  head.append(
    Object.assign(document.createElement('h2'), { textContent: 'YouTube 播客' }),
    Object.assign(document.createElement('p'), {
      className: 'section-kicker',
      textContent: '按博主列出金融和 AI 播客。先看中文摘要，需要时再展开全文。',
    }),
  );
  const sync = document.createElement('button');
  sync.type = 'button';
  sync.className = 'text-button';
  sync.textContent = '检查新的一集';
  sync.addEventListener('click', async () => {
    sync.disabled = true;
    try {
      const payload = await api('/api/v1/youtube-podcasts/sync', { method: 'POST' });
      showToast(payload.status === 'already-running' ? '这一轮已经在跑' : '已排进今天的检查');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '没有排上检查');
    } finally {
      sync.disabled = false;
    }
  });
  page.append(head);
  const list = document.createElement('div');
  list.className = 'podcast-list';
  list.textContent = '正在读取…';
  page.append(list);
  root.append(page);

  api('/api/v1/youtube-podcasts').then((payload) => {
    if (payload.enabled === false) {
      sync.hidden = true;
      head.append(Object.assign(document.createElement('p'), { className: 'section-kicker', textContent: '未开启' }));
    } else {
      head.append(sync);
    }
    if (payload.configError) {
      head.append(Object.assign(document.createElement('p'), { className: 'section-kicker', textContent: '配置缺失' }));
    }
    const creators = payload.creators || [];
    list.replaceChildren();
    if (payload.enabled !== false && !creators.some((creator) => creator.episodes?.length)) {
      list.append(Object.assign(document.createElement('p'), {
        className: 'section-kicker',
        textContent: '还没有播客。打开开关后，每天早上会检查新的一集。',
      }));
    }
    for (const creator of creators) {
      if (!creator.episodes?.length) continue;
      const block = document.createElement('section');
      block.className = 'podcast-creator';
      block.append(
        Object.assign(document.createElement('h3'), { textContent: creator.name }),
        Object.assign(document.createElement('p'), { className: 'section-kicker', textContent: creator.focus || '' }),
      );
      for (const episode of creator.episodes) {
        block.append(episodeRow(episode, { api, open: videoId === episode.videoId }));
      }
      list.append(block);
    }
  }).catch((error) => {
    list.textContent = error instanceof Error ? error.message : '播客读取失败';
  });
}

function episodeRow(episode, { api, open }) {
  const row = document.createElement('article');
  row.className = 'podcast-episode';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'podcast-episode-title';
  button.append(
    Object.assign(document.createElement('strong'), { textContent: episode.title || episode.originalTitle || episode.videoId }),
    Object.assign(document.createElement('small'), {
      textContent: [
        episode.originalTitle && episode.originalTitle !== episode.title ? episode.originalTitle : '',
        clock(episode.publishedAt),
        minutes(episode.durationSec),
        SOURCE_LABEL[episode.transcriptSource] || '',
        episodeArticleMessage(episode),
      ].filter(Boolean).join(' · '),
    }),
  );
  const detail = document.createElement('div');
  detail.className = 'podcast-detail';
  detail.hidden = !open;
  button.addEventListener('click', () => {
    detail.hidden = !detail.hidden;
    if (!detail.hidden && !detail.dataset.ready) fillDetail(detail, episode, api);
  });
  if (open) fillDetail(detail, episode, api);
  row.append(button, detail);
  return row;
}

function fillDetail(detail, episode, api) {
  detail.dataset.ready = '1';
  detail.replaceChildren();
  const summary = document.createElement('pre');
  summary.className = 'podcast-summary';
  summary.textContent = episode.summary || '这一集还没有摘要。';
  const link = document.createElement('a');
  link.href = youtubeWatchUrl(episode.videoId) || episode.sourceUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = '原帖';
  const transcriptButton = document.createElement('button');
  transcriptButton.type = 'button';
  transcriptButton.className = 'text-button';
  transcriptButton.textContent = '展开全文';
  const transcript = document.createElement('div');
  transcript.className = 'podcast-transcript';
  transcript.hidden = true;
  transcriptButton.addEventListener('click', async () => {
    if (!transcript.hidden) {
      transcript.hidden = true;
      transcriptButton.textContent = '展开全文';
      return;
    }
    if (!transcript.dataset.loaded) {
      transcriptButton.disabled = true;
      try {
        const payload = await api(`/api/v1/youtube-podcasts/${encodeURIComponent(episode.videoId)}`);
        const loaded = payload.episode || episode;
        const body = loaded.body || '';
        const articleStatus = loaded.articleStatus || episode.articleStatus || '';
        const articleReady = articleStatus === 'ready' || loaded.article?.status === 'ready';
        transcript.replaceChildren();
        if (articleReady) {
          const article = document.createElement('div');
          article.className = 'podcast-article';
          renderMarkdownInto(article, body || '没有全文。');
          attachYoutubeHeadingTimes(article, episode.videoId, { subtitle: true });
          markPodcastKeypoints(article);
          transcript.append(article);
        } else {
          const partial = loaded.partial || episode.partial;
          const message = loaded.article?.message || episode.article?.message || episodeArticleMessage(loaded) || episodeArticleMessage(episode);
          const line = partialArticleLabel(partial, message);
          if (line) appendPartialArticle(transcript, partial, line);
          else {
            transcript.append(Object.assign(document.createElement('p'), {
              className: 'podcast-pending',
              textContent: message || '中文整理排队中',
            }));
          }
          transcript.append(foldedOriginal(body));
        }
        transcript.dataset.loaded = '1';
      } catch (error) {
        transcript.textContent = error instanceof Error ? error.message : '全文读取失败';
      } finally {
        transcriptButton.disabled = false;
      }
    }
    transcript.hidden = false;
    transcriptButton.textContent = '收起全文';
  });
  detail.append(summary, link, transcriptButton, transcript);
}

export const PODCAST_PAGE_SIZE = 20;

export function podcastSpeedReadReady(episode) {
  const speed = episode?.speedRead;
  const text = String(speed?.text || speed?.body || '').trim();
  return Boolean(text) && (speed?.status === 'ready' || speed?.ready === true);
}

export function podcastArticleReady(episode) {
  return episode?.article?.status === 'ready' || episode?.articleStatus === 'ready';
}

export function podcastStatusLabel(episode) {
  if (podcastSpeedReadReady(episode)) return '速读可用';
  if (podcastArticleReady(episode)) return '已整理';
  const transcript = String(episode?.transcriptSource || '').trim();
  const ingest = String(episode?.status || '');
  if ((ingest && ingest !== 'ready') || (!transcript && !episode?.articleStatus && !episode?.article?.status)) return '视频待整理';
  return '整理中';
}

export function podcastDurationLabel(durationSec) {
  const value = Number(durationSec) || 0;
  if (!value) return '';
  const total = Math.max(1, Math.round(value / 60));
  if (total < 60) return `${total}分钟`;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return mins ? `${hours}小时${mins}分钟` : `${hours}小时`;
}

function podcastTimeLabel(at, now = Date.now()) {
  const time = Number(at) || 0;
  if (!time) return '';
  const clock = clockLabel(time);
  if (dateKey(time) === dateKey(now)) return clock;
  return `${monthDayLabel(time)} ${clock}`;
}

export function podcastEpisodes(payload) {
  const rows = [];
  for (const creator of payload?.creators || []) {
    for (const episode of creator.episodes || []) {
      rows.push({
        ...episode,
        creatorId: episode.creatorId || creator.id,
        creatorName: episode.creatorName || creator.name || creator.id,
      });
    }
  }
  rows.sort((left, right) => (Number(right.publishedAt) || 0) - (Number(left.publishedAt) || 0)
    || String(right.videoId).localeCompare(String(left.videoId)));
  return rows;
}

export function podcastChannels(payload) {
  const channels = (payload?.creators || []).map((creator) => {
    const episodes = podcastEpisodes({ creators: [creator] });
    const latest = episodes[0];
    return {
      id: creator.id,
      name: creator.name || creator.id,
      focus: creator.focus || '',
      followed: Boolean(creator.followed),
      unread: episodes.filter((episode) => !episode.isRead).length,
      total: episodes.length,
      latestTitle: latest?.title || latest?.originalTitle || '',
      latestAt: Number(latest?.publishedAt) || 0,
    };
  }).filter((channel) => channel.total > 0);
  channels.sort((left, right) => {
    if (left.followed !== right.followed) return left.followed ? -1 : 1;
    if ((left.unread > 0) !== (right.unread > 0)) return left.unread > 0 ? -1 : 1;
    return right.latestAt - left.latestAt || String(left.name).localeCompare(String(right.name), 'zh');
  });
  return channels;
}

function podcastMeta(episode) {
  return [episode.creatorName, podcastDurationLabel(episode.durationSec), podcastStatusLabel(episode)].filter(Boolean).join(' · ');
}

function el(tag, className, text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function renderPodcastLibrary(root, {
  payload = {},
  pane = 'episodes',
  channel = '',
  shown = PODCAST_PAGE_SIZE,
  now = Date.now(),
  focused = () => false,
  starIcon = '',
  onOpen = () => {},
  onStar = () => {},
  onPane = () => {},
  onChannel = () => {},
  onClearChannel = () => {},
  onMore = () => {},
} = {}) {
  root.replaceChildren();
  const page = el('section', 'podcast-zone');
  const switcher = el('div', 'podcast-switch');
  switcher.setAttribute('role', 'tablist');
  switcher.setAttribute('aria-label', '播客范围');
  for (const item of [{ id: 'episodes', label: '单集' }, { id: 'channels', label: '频道' }]) {
    const tab = el('button', `podcast-switch-tab${pane === item.id ? ' is-active' : ''}`, item.label);
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', pane === item.id ? 'true' : 'false');
    if (pane === item.id) tab.setAttribute('aria-current', 'page');
    tab.addEventListener('click', () => onPane(item.id));
    switcher.append(tab);
  }
  page.append(switcher);

  const episodes = podcastEpisodes(payload);
  const activeChannel = channel ? (payload.creators || []).find((creator) => creator.id === channel) : null;
  if (pane === 'episodes' && channel) {
    const filter = el('p', 'podcast-filter');
    filter.append(el('span', '', activeChannel?.name || channel));
    const clear = el('button', 'text-button', '全部单集');
    clear.type = 'button';
    clear.addEventListener('click', () => onClearChannel());
    filter.append(clear);
    page.append(filter);
  }

  if (payload.enabled === false && !episodes.length) {
    page.append(el('p', 'empty-state', '播客还没打开。打开开关后，这里会按发布时间列出单集。'));
    root.append(page);
    return;
  }
  if (payload.configError && !episodes.length) {
    page.append(el('p', 'empty-state', '播客配置缺失，暂时列不出来。'));
    root.append(page);
    return;
  }

  if (pane === 'channels') {
    const channels = podcastChannels(payload);
    if (!channels.length) {
      page.append(el('p', 'empty-state', '还没有播客频道。'));
      root.append(page);
      return;
    }
    const list = el('div', 'podcast-channels');
    for (const item of channels) {
      const row = el('button', `podcast-channel${item.unread ? '' : ' is-muted'}`);
      row.type = 'button';
      row.append(el('span', 'podcast-channel-mark', String(item.name || '播').slice(0, 1)));
      const copy = el('span', 'podcast-channel-copy');
      const title = el('strong', '', item.name);
      if (item.followed) title.append(el('span', 'news-tag', '已关注'));
      const latest = item.latestTitle ? `最新：${item.latestTitle}` : '还没有单集';
      const unread = item.unread > 0 ? `${item.unread} 集未读` : '没有未读';
      copy.append(title, el('small', '', `${unread} · ${latest}`));
      row.append(copy);
      row.addEventListener('click', () => onChannel(item.id));
      list.append(row);
    }
    page.append(list);
    root.append(page);
    return;
  }

  const visible = channel ? episodes.filter((episode) => episode.creatorId === channel) : episodes;
  if (!visible.length) {
    const empty = el('p', 'empty-state', channel
      ? '这个频道还没有单集。'
      : '还没有播客单集。打开开关后，每天早上会检查新的一集。');
    page.append(empty);
    if (channel) {
      const back = el('button', 'text-button', '查看全部单集');
      back.type = 'button';
      back.addEventListener('click', () => onClearChannel());
      page.append(back);
    }
    root.append(page);
    return;
  }

  const count = el('p', 'podcast-count', shown >= visible.length ? `共 ${visible.length} 条` : `已显示 ${Math.min(shown, visible.length)} / ${visible.length} 条`);
  const list = el('ul', 'news-rows podcast-episodes');
  for (const episode of visible.slice(0, shown)) {
    const item = el('li', `news-row${episode.isRead ? ' is-muted' : ''}`);
    item.dataset.videoId = episode.videoId || '';
    const copy = el('div', 'news-row-copy');
    const open = el('button', 'news-row-body official-event-body feed-content');
    open.type = 'button';
    const when = podcastTimeLabel(episode.publishedAt, now);
    if (when) {
      const time = el('time', 'news-row-time', when);
      if (episode.publishedAt) time.dateTime = new Date(episode.publishedAt).toISOString();
      open.append(time);
    }
    open.append(el('h3', 'news-row-title', episode.title || episode.originalTitle || episode.videoId || '未命名单集'));
    open.append(el('small', 'news-row-source', podcastMeta(episode)));
    open.addEventListener('click', () => onOpen(episode));
    copy.append(open);
    item.append(copy);
    const star = el('button', `icon-button ghost focus-btn${focused(episode) ? ' on' : ''}`);
    star.type = 'button';
    star.setAttribute('aria-label', focused(episode) ? '取消重点' : '标为重点');
    star.innerHTML = starIcon || '';
    star.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onStar(episode);
    });
    item.append(star);
    list.append(item);
  }
  page.append(count, list);
  if (shown < visible.length) {
    const more = el('button', 'text-button podcast-more', '加载更多');
    more.type = 'button';
    more.addEventListener('click', () => onMore());
    page.append(more);
  }
  root.append(page);
}

function readerTab(label, active, onClick) {
  const tab = el('button', `podcast-switch-tab${active ? ' is-active' : ''}`, label);
  tab.type = 'button';
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', active ? 'true' : 'false');
  tab.addEventListener('click', onClick);
  return tab;
}

// 窄屏阅读：页头随正文滚走。只有继续上滚、且已经离开页头之后，才露出一行返回 / 短标题 / 速读。
export function podcastReaderFloatVisibility({
  previousY = 0,
  nextY = 0,
  shown = false,
  narrow = true,
  revealAfter = 48,
} = {}) {
  const y = Number(nextY) || 0;
  if (!narrow || y < revealAfter) return false;
  const delta = y - (Number(previousY) || 0);
  if (delta > 4) return false;
  if (delta < -4) return true;
  return Boolean(shown);
}

function bindPodcastChrome(root, floatBar, flowBar) {
  const view = typeof window !== 'undefined' ? window : null;
  if (!view || typeof view.addEventListener !== 'function' || !floatBar) return;
  if (typeof root._podcastScrollCleanup === 'function') root._podcastScrollCleanup();
  // 页壳有 overflow-x: clip，固定条放在 body 上才相对视口，而不是被滚走的页头带着走。
  if (typeof document.querySelectorAll === 'function') {
    for (const node of document.querySelectorAll('.podcast-reader-float')) {
      if (node !== floatBar) node.remove();
    }
  }
  if (document.body && typeof document.body.append === 'function' && floatBar.parentElement !== document.body) {
    document.body.append(floatBar);
  }
  let lastY = Number(view.scrollY) || 0;
  let shown = false;
  let ticking = false;
  const media = typeof view.matchMedia === 'function' ? view.matchMedia('(max-width: 720px)') : null;
  const release = () => {
    view.removeEventListener('scroll', onScroll);
    if (typeof floatBar.remove === 'function' && flowBar?.isConnected === false) floatBar.remove();
    if (root._podcastScrollCleanup === release) root._podcastScrollCleanup = null;
  };
  const apply = () => {
    ticking = false;
    if (flowBar?.isConnected === false || floatBar.isConnected === false) {
      release();
      return;
    }
    const y = Number(view.scrollY) || 0;
    const gate = Math.max(72, Number(flowBar?.offsetHeight) || 0);
    shown = podcastReaderFloatVisibility({
      previousY: lastY,
      nextY: y,
      shown,
      narrow: media ? media.matches : true,
      revealAfter: gate,
    });
    lastY = y;
    if (floatBar.classList && typeof floatBar.classList.toggle === 'function') {
      floatBar.classList.toggle('is-shown', shown);
    } else {
      floatBar.className = shown ? 'podcast-reader-float is-shown' : 'podcast-reader-float';
    }
    floatBar.setAttribute('aria-hidden', shown ? 'false' : 'true');
    if ('inert' in floatBar) floatBar.inert = !shown;
  };
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    if (typeof view.requestAnimationFrame === 'function') view.requestAnimationFrame(apply);
    else apply();
  };
  view.addEventListener('scroll', onScroll, { passive: true });
  let observer = null;
  if (typeof MutationObserver === 'function' && root) {
    observer = new MutationObserver(() => {
      if (flowBar?.isConnected === false) {
        observer.disconnect();
        release();
      }
    });
    observer.observe(root, { childList: true });
  }
  root._podcastScrollCleanup = () => {
    observer?.disconnect();
    release();
  };
}

function readerTabs(reading, onMode, className) {
  const tabs = el('div', className);
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '阅读版本');
  tabs.append(
    readerTab('速读版', reading === 'speed', () => onMode('speed')),
    readerTab('全文', reading === 'full', () => onMode('full')),
  );
  return tabs;
}

export function renderPodcastReader(root, {
  episode,
  mode = 'full',
  starIcon = '',
  focused = false,
  onBack = () => {},
  onMode = () => {},
  onChannel = () => {},
  onStar = () => {},
} = {}) {
  root.replaceChildren();
  const reading = mode === 'speed' ? 'speed' : 'full';
  const article = el('article', 'page-article podcast-reader');
  article.dataset.mode = reading;
  article.dataset.status = podcastStatusLabel(episode);
  const bar = el('div', 'podcast-reader-bar');
  const back = el('button', 'podcast-reader-back', '‹ 返回');
  back.type = 'button';
  back.addEventListener('click', () => onBack());
  const title = el('h2', 'podcast-reader-title', episode?.title || episode?.originalTitle || '未命名单集');
  const meta = el('div', 'podcast-reader-meta');
  const channelName = episode?.creatorName || '';
  if (channelName) {
    const channel = el('button', 'text-button podcast-reader-channel', channelName);
    channel.type = 'button';
    channel.addEventListener('click', () => onChannel(episode.creatorId || ''));
    meta.append(channel);
  }
  const href = youtubeWatchUrl(episode?.videoId) || episode?.sourceUrl || '';
  if (href) {
    const link = el('a', 'podcast-reader-youtube', '打开 YouTube ↗');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    meta.append(link);
  }
  meta.append(el('span', 'podcast-reader-status', podcastStatusLabel(episode)));
  const star = el('button', `icon-button ghost focus-btn${focused ? ' on' : ''}`);
  star.type = 'button';
  star.setAttribute('aria-label', focused ? '取消重点' : '标为重点');
  star.innerHTML = starIcon || '';
  star.addEventListener('click', () => onStar());
  meta.append(star);
  bar.append(back, title, meta, readerTabs(reading, onMode, 'podcast-switch podcast-reader-tabs'));
  const floatBar = el('div', 'podcast-reader-float');
  floatBar.setAttribute('aria-hidden', 'true');
  const floatBack = el('button', 'podcast-reader-back', '‹ 返回');
  floatBack.type = 'button';
  floatBack.addEventListener('click', () => onBack());
  const floatTitle = el('p', 'podcast-reader-float-title', episode?.title || episode?.originalTitle || '未命名单集');
  floatBar.append(floatBack, floatTitle, readerTabs(reading, onMode, 'podcast-switch podcast-reader-float-tabs'));
  const body = el('div', 'reader-content detail-body');
  body.dataset.readerPane = reading;
  if (reading === 'speed') fillSpeedRead(body, episode, () => onMode('full'));
  else fillFullArticle(body, episode);
  article.append(bar, body, floatBar);
  root.append(article);
  bindPodcastChrome(root, floatBar, bar);
}

function markPodcastKeypoints(article) {
  if (typeof article?.querySelector !== 'function') return;
  const heading = article.querySelector('h2, h3, h4');
  const label = String(heading?.textContent || '').trim();
  if (heading && /^要点(?:\s|$)/.test(label)) heading.classList.add('podcast-keypoints');
}

function fillSpeedRead(body, episode, onFull) {
  if (podcastSpeedReadReady(episode)) {
    const text = String(episode.speedRead.text || episode.speedRead.body || '');
    renderMarkdownInto(body, text);
    return;
  }
  const note = el('p', 'podcast-speed-note');
  const ready = podcastArticleReady(episode);
  note.append(document.createTextNode(ready ? '速读整理中。可以先看全文。' : '速读整理中。全文也还在整理。'));
  if (ready) {
    const jump = el('button', 'text-button', '查看全文');
    jump.type = 'button';
    jump.addEventListener('click', () => onFull());
    note.append(jump);
  }
  body.append(note);
}

function fillFullArticle(body, episode) {
  if (podcastArticleReady(episode)) {
    if (!String(episode.body || '').trim()) {
      body.append(el('p', 'podcast-pending', '正在读取正文…'));
      return;
    }
    const article = el('div', 'podcast-article');
    renderMarkdownInto(article, episode.body);
    attachYoutubeHeadingTimes(article, episode.videoId, { subtitle: true });
    markPodcastKeypoints(article);
    body.append(article);
    return;
  }
  const message = episodeArticleMessage(episode) || (podcastStatusLabel(episode) === '视频待整理' ? '视频待整理，还没有中文正文。' : '中文整理还没完成。');
  body.append(el('p', 'podcast-pending', message));
  appendPartialArticle(body, episode?.partial, partialArticleLabel(episode?.partial, message));
  if (String(episode?.body || '').trim()) body.append(foldedOriginal(episode.body));
}
