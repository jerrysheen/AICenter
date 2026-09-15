const state = {
  session: null,
  posts: [],
  pairing: null,
  stream: null,
};

const elements = Object.fromEntries([
  'connection-state', 'server-name', 'session-description', 'pairing-panel', 'pairing-qr',
  'network-address', 'pairing-code', 'refresh-pairing', 'unpaired-panel', 'authorized-content',
  'post-form', 'post-title', 'post-body', 'form-message', 'feed', 'feed-count', 'metrics-panel',
  'metric-devices', 'metric-opens', 'metric-published', 'metric-details', 'device-list',
  'post-dialog', 'dialog-title', 'dialog-body', 'dialog-tags', 'dialog-source', 'dialog-time', 'toast',
].map((id) => [id, document.getElementById(id)]));

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

function setConnection(kind, label) {
  elements['connection-state'].className = `connection-state ${kind}`;
  elements['connection-state'].querySelector('span').textContent = label;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => elements.toast.classList.remove('visible'), 2600);
}

function logBehavior(name, metadata = {}) {
  api('/api/v1/behavior', { method: 'POST', body: JSON.stringify({ name, metadata }) }).catch(() => {});
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(timestamp);
}

function renderPosts() {
  elements.feed.replaceChildren();
  elements['feed-count'].textContent = `${state.posts.length} 条`;
  if (!state.posts.length) {
    const empty = document.createElement('div');
    empty.className = 'loading-card';
    empty.textContent = '还没有信息，发布第一条吧。';
    elements.feed.append(empty);
    return;
  }
  for (const post of state.posts) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'post-card';
    card.addEventListener('click', () => openPost(post));

    const meta = document.createElement('div');
    meta.className = 'post-meta';
    const source = document.createElement('span');
    source.textContent = post.createdByDevice ? '手机发布' : '本机发布';
    const time = document.createElement('time');
    time.dateTime = new Date(post.createdAt).toISOString();
    time.textContent = formatTime(post.createdAt);
    meta.append(source, time);

    const title = document.createElement('h3');
    title.textContent = post.title;
    const body = document.createElement('p');
    body.textContent = post.body || '无正文';
    card.append(meta, title, body);

    if (post.tags.length) {
      const tags = document.createElement('div');
      tags.className = 'tags';
      for (const tag of post.tags) {
        const chip = document.createElement('span');
        chip.textContent = tag;
        tags.append(chip);
      }
      card.append(tags);
    }
    elements.feed.append(card);
  }
}

function openPost(post) {
  elements['dialog-title'].textContent = post.title;
  elements['dialog-body'].textContent = post.body || '无正文';
  elements['dialog-tags'].replaceChildren(...post.tags.map((tag) => {
    const chip = document.createElement('span');
    chip.textContent = tag;
    return chip;
  }));
  elements['dialog-source'].classList.toggle('hidden', !post.sourceUrl);
  elements['dialog-source'].href = post.sourceUrl || '#';
  elements['dialog-time'].textContent = `发布于 ${new Date(post.createdAt).toLocaleString('zh-CN')}`;
  elements['post-dialog'].showModal();
  logBehavior('post.opened', { postId: post.id });
}

async function loadPosts() {
  const payload = await api('/api/v1/posts');
  state.posts = payload.posts;
  renderPosts();
  logBehavior('feed.loaded', { count: state.posts.length });
}

async function loadPairing() {
  const payload = await api('/api/v1/pairing');
  state.pairing = payload;
  elements['network-address'].replaceChildren(...payload.candidates.map((candidate, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = candidate.baseUrl;
    return option;
  }));
  updatePairingCandidate();
}

function updatePairingCandidate() {
  const candidate = state.pairing?.candidates[Number(elements['network-address'].value || 0)];
  if (!candidate) {
    elements['pairing-qr'].removeAttribute('src');
    elements['pairing-code'].textContent = '未发现局域网地址';
    return;
  }
  elements['pairing-qr'].src = candidate.qrDataUrl;
  elements['pairing-code'].textContent = state.pairing.code;
}

async function loadMetrics() {
  if (state.session?.role !== 'desktop') return;
  const [{ metrics }, { devices }] = await Promise.all([api('/api/v1/metrics'), api('/api/v1/devices')]);
  elements['metric-devices'].textContent = metrics.activeDevices;
  elements['metric-opens'].textContent = metrics.appOpens;
  elements['metric-published'].textContent = metrics.published;
  elements['metric-details'].textContent = metrics.detailsOpened;
  elements['device-list'].replaceChildren(...devices.filter((device) => !device.revokedAt).map((device) => {
    const row = document.createElement('div');
    const copy = document.createElement('span');
    copy.textContent = `${device.name} · ${formatTime(device.lastSeenAt)}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '撤销';
    button.addEventListener('click', async () => {
      await api(`/api/v1/devices/${device.id}`, { method: 'DELETE' });
      await loadMetrics();
    });
    row.append(copy, button);
    return row;
  }));
}

function connectStream() {
  state.stream?.close();
  state.stream = new EventSource('/api/v1/events/stream');
  state.stream.addEventListener('ready', () => setConnection('online', '实时连接'));
  state.stream.addEventListener('post.created', (event) => {
    const { post } = JSON.parse(event.data);
    state.posts = [post, ...state.posts.filter((item) => item.id !== post.id)];
    renderPosts();
    showToast('收到一条新信息');
    loadMetrics().catch(() => {});
  });
  state.stream.addEventListener('device.paired', () => loadMetrics().catch(() => {}));
  state.stream.onerror = () => setConnection('waiting', '正在重连');
}

async function pairFromUrl() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('pair');
  if (!code) return false;
  const deviceName = /Mobile|HarmonyOS|Android|iPhone/i.test(navigator.userAgent) ? '我的鸿蒙手机' : '浏览器设备';
  setConnection('waiting', '正在配对');
  await api('/api/v1/pair', { method: 'POST', body: JSON.stringify({ code, deviceName }) });
  url.searchParams.delete('pair');
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  showToast('配对成功，以后打开即可连接');
  return true;
}

async function initialize() {
  try {
    await pairFromUrl();
    const { ok, ...session } = await api('/api/v1/session');
    state.session = session;
    elements['server-name'].textContent = session.serverName;
    elements['session-description'].textContent = session.role === 'desktop'
      ? '本机管理端 · 可生成手机二维码'
      : `${session.device.name} · 已长期授权`;
    elements['authorized-content'].classList.remove('hidden');
    elements['unpaired-panel'].classList.add('hidden');
    if (session.role === 'desktop') {
      elements['pairing-panel'].classList.remove('hidden');
      elements['metrics-panel'].classList.remove('hidden');
      await Promise.all([loadPairing(), loadMetrics()]);
    }
    await loadPosts();
    logBehavior('app.open', { role: session.role });
    connectStream();
  } catch (error) {
    setConnection('offline', '尚未连接');
    elements['unpaired-panel'].classList.remove('hidden');
    elements['authorized-content'].classList.add('hidden');
    elements['session-description'].textContent = error.message;
    const url = new URL(window.location.href);
    if (url.searchParams.has('pair')) showToast(error.message);
  }
}

elements['post-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  elements['form-message'].textContent = '正在发布…';
  const data = new FormData(event.currentTarget);
  try {
    const payload = await api('/api/v1/posts', {
      method: 'POST',
      body: JSON.stringify({
        title: data.get('title'), body: data.get('body'), sourceUrl: data.get('sourceUrl'), tags: data.get('tags'),
      }),
    });
    state.posts = [payload.post, ...state.posts.filter((item) => item.id !== payload.post.id)];
    renderPosts();
    event.currentTarget.reset();
    elements['form-message'].textContent = '发布成功';
    showToast('信息已发布');
    await loadMetrics();
  } catch (error) {
    elements['form-message'].textContent = error.message;
  }
});

let composerLogged = false;
elements['post-form'].addEventListener('focusin', () => {
  if (composerLogged) return;
  composerLogged = true;
  logBehavior('composer.started');
});

elements['post-form'].addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') elements['post-form'].requestSubmit();
});
elements['network-address'].addEventListener('change', updatePairingCandidate);
elements['refresh-pairing'].addEventListener('click', () => loadPairing().catch((error) => showToast(error.message)));
elements['post-dialog'].querySelector('.dialog-close').addEventListener('click', () => elements['post-dialog'].close());

initialize();
