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
      textContent: [clock(episode.publishedAt), minutes(episode.durationSec), SOURCE_LABEL[episode.transcriptSource] || ''].filter(Boolean).join(' · '),
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
  link.href = episode.sourceUrl;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = '打开原视频';
  const transcriptButton = document.createElement('button');
  transcriptButton.type = 'button';
  transcriptButton.className = 'text-button';
  transcriptButton.textContent = '展开全文';
  const transcript = document.createElement('pre');
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
        transcript.textContent = payload.episode?.body || '没有全文。';
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
