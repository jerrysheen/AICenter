const COLORS = ['#c2410c', '#0369a1', '#15803d', '#7c3aed', '#b45309', '#0f766e', '#be123c'];

function text(value) {
  return String(value || '').trim();
}

function formatTime(at) {
  const time = Number(at);
  if (!Number.isFinite(time) || time <= 0) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(time);
}

function line(values, color, width, height, pad, dashed) {
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  let path = '';
  let open = false;
  values.forEach((value, index) => {
    if (value === null || value === undefined) {
      open = false;
      return;
    }
    const x = pad + step * index;
    const y = height - pad - (Math.max(0, Math.min(1, value)) * (height - pad * 2));
    path += `${open ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    open = true;
  });
  if (!path) return '';
  return `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" ${dashed ? 'stroke-dasharray="4 3"' : ''}/>`;
}

function chartSvg(seriesKey, view) {
  const width = 640;
  const height = 168;
  const pad = 24;
  const series = view.drift?.series || [];
  const likes = view.drift?.likes || [];
  const maxLikes = Math.max(1, ...likes);
  const likeRate = likes.map((count) => count / maxLikes);
  const paths = series.map((entry, index) => line(entry[seriesKey] || [], COLORS[index % COLORS.length], width, height, pad, false)).join('');
  const likePath = line(likeRate, '#64748b', width, height, pad, true);
  const dates = view.drift?.dates || [];
  const labels = dates.map((label, index) => {
    if (dates.length > 8 && index % 2) return '';
    const step = dates.length > 1 ? (width - pad * 2) / (dates.length - 1) : 0;
    return `<text x="${pad + step * index}" y="${height - 6}" font-size="10" fill="#64748b">${label}</text>`;
  }).join('');
  return `<svg class="x-focus-chart" viewBox="0 0 ${width} ${height}" role="img">${paths}${likePath}${labels}</svg>`;
}

function legend(view) {
  const row = document.createElement('div');
  row.className = 'x-focus-legend';
  (view.drift?.series || []).forEach((entry, index) => {
    const item = document.createElement('span');
    item.innerHTML = `<i style="background:${COLORS[index % COLORS.length]}"></i>${entry.name}`;
    row.append(item);
  });
  const likes = document.createElement('span');
  likes.innerHTML = '<i style="background:#64748b"></i>点赞次数';
  row.append(likes);
  return row;
}

export function createXFocusPage({ api, showToast }) {
  return {
    async render(root) {
      root.replaceChildren();
      const loading = document.createElement('p');
      loading.className = 'empty-state';
      loading.textContent = '正在读取推荐记录…';
      root.append(loading);
      let view;
      try {
        view = await api('/api/v1/feed/x-focus', { fresh: true });
      } catch (error) {
        loading.textContent = error.message || '推荐记录读取失败';
        return;
      }
      if (!view?.ok) {
        loading.textContent = '推荐记录还没有准备好';
        return;
      }
      root.replaceChildren();
      const refresh = () => this.render(root);
      root.append(switchCard(view, refresh), driftCard(view), actionCard(view, api, showToast, refresh));
    },
  };
}

function switchCard(view, refresh) {
  const card = document.createElement('section');
  card.className = 'x-focus-card';
  const state = view.autoLike || {};
  const title = document.createElement('h2');
  title.textContent = '自动点赞';
  const summary = document.createElement('p');
  summary.textContent = `今天 ${state.todayCount || 0} / ${state.todayLimit || 0} 次，这一小时 ${state.hourCount || 0} / ${state.hourLimit || 0} 次。两次之间至少间隔 2 分钟。`;
  const label = document.createElement('label');
  label.className = 'x-focus-switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(state.pageOn);
  input.addEventListener('change', async () => {
    input.disabled = true;
    try {
      await api('/api/v1/feed/x-focus/auto-like', { method: 'POST', body: JSON.stringify({ enabled: input.checked }) });
      refresh();
    } catch (error) {
      input.checked = !input.checked;
      const note = card.querySelector('.x-focus-notice');
      if (note) note.textContent = error.message || '没有保存开关';
    } finally {
      input.disabled = false;
    }
  });
  label.append(input, document.createTextNode(' 打开自动点赞'));
  const notice = document.createElement('p');
  notice.className = `x-focus-notice${state.stopped ? ' is-stopped' : ''}`;
  notice.textContent = text(state.notice);
  card.append(title, summary, label, notice);
  return card;
}

function driftCard(view) {
  const card = document.createElement('section');
  card.className = 'x-focus-card';
  const title = document.createElement('h2');
  title.textContent = '方向命中率';
  const hint = document.createElement('p');
  hint.textContent = '每天按方向统计相关内容占当天抓取的比例，推荐和关注分开。灰色虚线是当天点赞次数，按这段时间里的最高一天缩放。';
  card.append(title, hint);
  for (const [name, key] of [['推荐', 'recommended'], ['关注', 'following']]) {
    const heading = document.createElement('h3');
    heading.textContent = name;
    const frame = document.createElement('div');
    frame.innerHTML = chartSvg(key, view);
    card.append(heading, frame);
  }
  card.append(legend(view));
  const alerts = view.drift?.alerts || [];
  if (alerts.length) {
    const list = document.createElement('ul');
    list.className = 'x-focus-alerts';
    for (const message of alerts) {
      const item = document.createElement('li');
      item.textContent = message;
      list.append(item);
    }
    card.append(list);
  }
  return card;
}

function actionCard(view, api, showToast, refresh) {
  const card = document.createElement('section');
  card.className = 'x-focus-card';
  const title = document.createElement('h2');
  title.textContent = '点赞记录';
  card.append(title);
  const actions = view.actions || [];
  if (!actions.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '还没有点赞记录。';
    card.append(empty);
    return card;
  }
  for (const action of actions) {
    const row = document.createElement('article');
    row.className = 'x-focus-row';
    const main = document.createElement('div');
    const heading = document.createElement('strong');
    heading.textContent = text(action.title) || 'X 帖子';
    const meta = document.createElement('p');
    meta.textContent = [formatTime(action.at), action.sourceLabel, action.direction, action.scoreText && action.scoreText !== '—' ? `相关度 ${action.scoreText}` : '', action.result].filter(Boolean).join(' · ');
    const reason = document.createElement('p');
    reason.textContent = text(action.reason);
    main.append(heading, meta);
    if (reason.textContent) main.append(reason);
    row.append(main);
    const tools = document.createElement('div');
    tools.className = 'x-focus-tools';
    if (action.href) {
      const link = document.createElement('a');
      link.href = action.href;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = '原帖';
      tools.append(link);
    }
    if (action.canUnlike && action.contentItemId) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button';
      button.textContent = '取消点赞';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const created = await api(`/api/v1/content-items/${encodeURIComponent(action.contentItemId)}/x-unlike`, {
            method: 'POST', body: JSON.stringify({ confirmed: true }),
          });
          const path = `/api/v1/content-items/${encodeURIComponent(action.contentItemId)}/x-unlike/${encodeURIComponent(created.jobId)}`;
          for (let i = 0; i < 60; i += 1) {
            const payload = await api(path, { fresh: true });
            if (payload.job?.status === 'completed') {
              showToast(payload.job.result?.status === 'unliked' ? '已取消点赞' : '请打开原帖确认是否已取消');
              refresh();
              return;
            }
            if (['failed', 'cancelled'].includes(payload.job?.status)) throw new Error('取消点赞没有完成');
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          showToast('取消点赞仍在处理');
        } catch (error) {
          showToast(error.message || '取消点赞没有完成');
          button.disabled = false;
        }
      });
      tools.append(button);
    }
    row.append(tools);
    card.append(row);
  }
  return card;
}
