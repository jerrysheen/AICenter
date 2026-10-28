import test from 'node:test';
import assert from 'node:assert/strict';

class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this.type = '';
    this.value = '';
    this.isConnected = false;
    this._className = '';
    this._text = '';
    this.classList = classListFor(this);
  }
  get className() { return this._className; }
  set className(value) { this._className = String(value || ''); }
  get textContent() { return this._text; }
  set textContent(value) { this._text = String(value ?? ''); }
  get options() { return this.children; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  removeAttribute(key) { delete this.attrs[key]; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  append(...nodes) {
    for (const node of nodes.flat()) {
      if (node && typeof node === 'object') node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) if (child) child.parentNode = null;
    this.children = [];
    if (nodes.length) this.append(...nodes);
  }
  remove() {
    const list = this.parentNode?.children;
    if (!list) return;
    const index = list.indexOf(this);
    if (index >= 0) list.splice(index, 1);
    this.parentNode = null;
  }
  insertBefore(node, before) {
    if (node && typeof node === 'object') node.parentNode = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
  }
  add(option) { this.children.push(option); }
  scrollIntoView() {}
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const out = [];
    const walk = node => {
      if (!node?.tagName) return;
      if (matches(node, selector)) out.push(node);
      for (const child of node.children || []) walk(child);
    };
    for (const child of this.children) walk(child);
    return out;
  }
}

function classListFor(el) {
  const names = () => el._className.split(/\s+/).filter(Boolean);
  return {
    contains: name => names().includes(name),
    add(...items) { for (const name of items) if (!names().includes(name)) el._className = `${el._className} ${name}`.trim(); },
    remove(...items) { const drop = new Set(items); el._className = names().filter(name => !drop.has(name)).join(' '); },
    toggle(name, force) { const on = force === undefined ? !names().includes(name) : Boolean(force); on ? this.add(name) : this.remove(name); return on; },
  };
}

function matches(node, selector) {
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
  if (!attr) return node.tagName === selector.toUpperCase();
  const key = attr[1].replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (attr[2] === undefined) return node.dataset[key] !== undefined || node.attrs[attr[1]] !== undefined;
  return attr[1].startsWith('data-') ? node.dataset[key] === attr[2] : node.attrs[attr[1]] === attr[2];
}

const memory = new Map();
globalThis.Option = function Option(text, value) { const node = new El('option'); node.textContent = text; node.value = value; return node; };
globalThis.document = { hidden: true, addEventListener() {}, createElement: tag => new El(tag) };
globalThis.window = { scrollY: 0, scrollTo() {} };
globalThis.localStorage = {
  getItem: key => memory.has(key) ? memory.get(key) : null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: key => memory.delete(key),
};

const { createInformationTreePage, sourceCaption } = await import('../apps/web/public/information-tree.js');

const HOUR = 3600000;
function edition(id, start, roots) {
  return { id, layer: 'hourly', window: { startAt: start, endAt: start + HOUR }, timezone: 'Asia/Shanghai', status: 'ready', roots, inputIds: roots, pendingIds: [], missingHours: [], generatedAt: start + 1000 };
}
function manifest(hours) {
  return { timezone: 'Asia/Shanghai', directions: {}, hours: hours.map(item => ({ edition: item })), days: [], information: [] };
}
function chips(root) { return root.querySelectorAll('.chip-tab'); }
function chip(root, start) { return chips(root).find(item => item.dataset.start === String(start)); }
function seenKey(device) { return `ai-center.hourly-seen.${encodeURIComponent(`desktop:${device}`)}`; }

function hostFor(device, source, state = {}) {
  return {
    session: () => ({ role: 'desktop', device: { id: device } }),
    active: () => true,
    loadTreeManifest: async () => structuredClone(source()),
    api(path) {
      if (path.startsWith('/api/v1/tags')) return Promise.resolve({ catalog: { tags: [] } });
      if (path.startsWith('/api/v1/reports/reading-hour/index')) {
        const error = new Error('not found');
        error.status = 404;
        return Promise.reject(error);
      }
      if (path.startsWith('/api/v1/reports/reading-hour')) {
        if (state.fail) return Promise.reject(new Error('读取失败'));
        const startAt = Number(new URL(path, 'http://tree.local').searchParams.get('startAt'));
        const item = source().hours.map(row => row.edition).find(row => row.window.startAt === startAt);
        if (!item?.roots?.length) {
          const error = new Error('missing');
          error.status = 404;
          return Promise.reject(error);
        }
        return Promise.resolve({ snapshot: {
          id: `rh:${item.id}`, status: 'ready', scored: item.roots.length, candidates: item.roots.length, selected: item.roots.length,
          items: item.roots.map(nodeId => ({ nodeId, title: '标题', disposition: 'hit', readingDirectionName: '产业个股', readingThemeName: '中国', timely: true })),
        } });
      }
      if (state.fail) return Promise.reject(new Error('读取失败'));
      const id = new URL(path, 'http://tree.local').searchParams.get('id');
      const item = source().hours.map(row => row.edition).find(row => row.id === id);
      if (!item) return Promise.reject(new Error('missing edition'));
      return Promise.resolve({ edition: item, nodes: item.roots.map(nodeId => ({ id: nodeId, title: '标题', text: '一条小时报', tagId: 'finance', layer: 'hourly' })) });
    },
  };
}

test('unread hours keep a red dot until that edition is opened', async () => {
  const start = Date.parse('2026-10-08T03:00:00Z');
  const current = edition('edition:currenthour01', start, ['n1']);
  const previous = edition('edition:previoushour1', start - HOUR, ['n2']);
  const empty = edition('edition:emptyhour0001', start - 2 * HOUR, []);
  let hours = [current, previous, empty];
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage(hostFor('hourly-dot', () => manifest(hours)));
  await page.mount(root, { mode: 'hourly' });

  assert.equal(chip(root, current.window.startAt).classList.contains('is-active'), true);
  assert.equal(chip(root, current.window.startAt).classList.contains('is-unread'), false);
  assert.equal(chip(root, previous.window.startAt).classList.contains('is-unread'), true);
  assert.equal(chip(root, previous.window.startAt).getAttribute('aria-label'), '10:00，未读');
  assert.equal(chip(root, empty.window.startAt).classList.contains('is-unread'), false);
  assert.equal(root.querySelector('[data-mode="hourly"]').classList.contains('is-unread'), true);
  assert.deepEqual(JSON.parse(localStorage.getItem(seenKey('hourly-dot'))), ['edition:currenthour01']);

  await chip(root, previous.window.startAt).listeners.click[0]();
  assert.equal(chip(root, previous.window.startAt).classList.contains('is-unread'), false);
  assert.equal(root.querySelector('[data-mode="hourly"]').classList.contains('is-unread'), false);
  assert.deepEqual(JSON.parse(localStorage.getItem(seenKey('hourly-dot'))).sort(), ['edition:currenthour01', 'edition:previoushour1']);

  hours = [edition('edition:nexthour000001', start + HOUR, ['n3']), edition('edition:currenthour02', start, ['n1']), previous];
  document.hidden = false;
  await page.check(true);
  document.hidden = true;
  await page.acceptUpdate();
  assert.equal(chip(root, start + HOUR).textContent, '12:00');
  assert.equal(chip(root, start + HOUR).classList.contains('is-unread'), true);
  assert.equal(chip(root, current.window.startAt).classList.contains('is-unread'), true);
  assert.equal(chip(root, previous.window.startAt).classList.contains('is-active'), true);
  assert.equal(chip(root, previous.window.startAt).classList.contains('is-unread'), false);
  assert.deepEqual(JSON.parse(localStorage.getItem(seenKey('hourly-dot'))).sort(), ['edition:currenthour01', 'edition:previoushour1']);

  const reloaded = new El('div'); reloaded.isConnected = true;
  const again = createInformationTreePage(hostFor('hourly-dot', () => manifest(hours)));
  await again.mount(reloaded, { mode: 'hourly' });
  assert.equal(chip(reloaded, start + HOUR).classList.contains('is-unread'), false);
  assert.equal(chip(reloaded, current.window.startAt).classList.contains('is-unread'), true);
  assert.equal(chip(reloaded, previous.window.startAt).classList.contains('is-unread'), false);
  again.stop();
  page.stop();
});

test('a failed hour stays unread and clears after a successful retry', async () => {
  const start = Date.parse('2026-10-08T03:00:00Z');
  const current = edition('edition:failehour0001', start, ['n1']);
  const state = { fail: true };
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage(hostFor('hourly-dot-fail', () => manifest([current]), state));
  await page.mount(root, { mode: 'hourly' });
  assert.equal(chip(root, start).classList.contains('is-active'), true);
  assert.equal(chip(root, start).classList.contains('is-unread'), true);
  assert.equal(localStorage.getItem(seenKey('hourly-dot-fail')), null);
  assert.equal(root.querySelectorAll('button').some(item => item.textContent === '这一期读取失败 · 重试'), true);

  state.fail = false;
  const retry = root.querySelectorAll('button').find(item => item.textContent === '这一期读取失败 · 重试');
  await retry.listeners.click[0]();
  assert.equal(chip(root, start).classList.contains('is-unread'), false);
  assert.deepEqual(JSON.parse(localStorage.getItem(seenKey('hourly-dot-fail'))), ['edition:failehour0001']);
  page.stop();
});

test('hourly titles fold open in place and keep the hour list', async () => {
  const start = Date.parse('2026-10-08T04:00:00Z');
  const info = { id: 'info-1', layer: 'information', title: '芯片出口', text: '摘要', body: '这是较长的中文正文', tagId: 'semiconductor', sourceRefs: [{ type: 'media-body', id: 'media-1' }] };
  const current = edition('edition:readerhour001', start, ['info-1']);
  let read = '';
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage({
    session: () => ({ role: 'desktop', device: { id: 'reader-bar' } }),
    active: () => true,
    readSavedSource: async (node) => { read = node.id; },
    loadTreeManifest: async () => manifest([current]),
    api(path) {
      if (path.startsWith('/api/v1/tags')) return Promise.resolve({ catalog: { tags: [] } });
      if (path.startsWith('/api/v1/reports/reading-hour/index')) {
        const error = new Error('not found'); error.status = 404; return Promise.reject(error);
      }
      if (path.startsWith('/api/v1/reports/reading-hour')) return Promise.resolve({ snapshot: {
        id: 'rh:reader', status: 'ready', scored: 1, candidates: 1, selected: 1,
        items: [{ nodeId: 'info-1', title: '芯片出口', disposition: 'hit', readingDirectionName: '科技与AI', readingThemeName: '中国', timely: true, id: 'info-1', layer: 'information', body: '这是较长的中文正文 [未抓取] 图片 ×2', text: '摘要', sourceUrl: 'https://example.com/chip', sourceRefs: [{ type: 'media-body', id: 'media-1' }] }],
      } });
      return Promise.reject(new Error('missing'));
    },
  });
  await page.mount(root, { mode: 'hourly' });
  assert.equal(root.classList.contains('is-reading'), false);
  assert.equal(root.querySelector('.reader-mobile-bar'), null);
  const fold = root.querySelector('details');
  assert.equal(fold.open, false);
  assert.equal(root.querySelector('.tree-hour-wheel').hidden, false);
  fold.open = true;
  await fold.listeners.toggle[0]();
  assert.equal(root.classList.contains('is-reading'), false);
  assert.equal(root.querySelector('.tree-hour-wheel').hidden, false);
  assert.equal(root.querySelector('.reading-toolbar'), null);
  const paragraph = root.querySelector('.reading-fold-body').children.find(node => node.tagName === 'P');
  assert.match(paragraph.textContent, /这是较长的中文正文/);
  assert.doesNotMatch(paragraph.textContent, /未抓取|图片/);
  const sourceLink = root.querySelector('.reading-source-link');
  assert.equal(sourceLink.textContent, '原文');
  assert.equal(sourceLink.href, 'https://example.com/chip');
  assert.equal(sourceLink.attrs.target, '_blank');
  assert.ok(root.querySelector('.feed-content'));
  await root.querySelectorAll('button').find(node => node.textContent === '原文').listeners.click[0]();
  assert.equal(read, 'info-1');
  fold.open = false;
  await fold.listeners.toggle[0]();
  assert.equal(root.querySelector('h3').textContent, '芯片出口');
  page.stop();
});

test('hourly reading shows hits and misses together and marks stale items', async () => {
  const start = Date.parse('2026-10-08T04:00:00Z');
  const current = edition('edition:readerhour002', start, ['info-1']);
  const snapshot = {
    id: 'rh:view', status: 'ready', scored: 2, candidates: 2, selected: 1,
    sections: [], items: [
      {nodeId: 'hit-1', title: '命中标题', disposition: 'hit', readingDirectionName: '产业个股', readingThemeName: '其他', timely: true},
      {nodeId: 'miss-1', title: '未命中旧闻', disposition: 'miss', readingDirectionName: '产业个股', readingThemeName: '其他', timely: false},
      {nodeId: 'out-1', title: '范围外讣告', disposition: 'out-of-scope', readingDirectionName: '待分类', readingThemeName: '', timely: false},
    ],
  };
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage({
    session: () => ({ role: 'desktop', device: { id: 'reader-parts' } }),
    active: () => true,
    loadTreeManifest: async () => manifest([current]),
    api(path) {
      if (path.startsWith('/api/v1/tags')) return Promise.resolve({ catalog: { tags: [] } });
      if (path.startsWith('/api/v1/reports/reading-hour')) return Promise.resolve({ snapshot });
      return Promise.reject(new Error('missing'));
    },
  });
  await page.mount(root, { mode: 'hourly' });
  const headings = root.querySelectorAll('h2').map(node => node.textContent);
  assert.equal(headings.includes('精确标题'), false);
  assert.equal(headings.includes('待分类'), false);
  assert.equal(headings.includes('产业个股'), true);
  assert.equal(headings.includes('其他'), false);
  assert.equal(root.querySelectorAll('h2').filter(node => node.className.split(/\s+/).includes('reading-direction') && node.textContent === '产业个股').length, 1);
  assert.equal(root.querySelectorAll('summary').some(node => node.textContent === '其他 1 条 ›'), false);
  assert.equal(root.querySelector('.reading-other'), null);
  const muted = root.querySelector('.is-muted');
  assert.equal(muted.querySelector('h3').textContent, '未命中旧闻');
  assert.match(muted.querySelector('.news-row-source').textContent, /产业个股/);
  assert.doesNotMatch(muted.querySelector('.news-row-source').textContent, /综合/);
  assert.doesNotMatch(muted.querySelector('.news-row-source').textContent, /其他/);
  assert.equal(muted.querySelector('.news-share'), null);
  const mutedFold = muted.querySelector('details');
  mutedFold.open = true;
  await mutedFold.listeners.toggle[0]();
  assert.equal(muted.querySelector('.reading-fold-body').querySelector('.news-tag').textContent, '综合');
  assert.equal(root.querySelectorAll('button').some(node => node.textContent === '关注精选'), false);
  assert.equal(root.querySelectorAll('h3').some(node => node.textContent.includes('范围外讣告')), false);
  assert.equal(root.querySelector('.reading-stale').textContent, '时效不足');
  const staleFold = root.querySelector('.reading-stale-fold');
  assert.equal(staleFold.open, false);
  assert.equal(staleFold.querySelector('summary').textContent, '旧闻补录 1 条');
  assert.equal(staleFold.querySelector('h3').textContent, '未命中旧闻');
  const titles = root.querySelectorAll('h3').map(node => node.textContent);
  assert.deepEqual(titles, ['命中标题', '未命中旧闻']);
  page.stop();
});

test('hour rows use ingest time and mark an earlier publish time', async () => {
  const start = Date.parse('2026-10-16T12:00:00Z');
  const current = edition('edition:ingesthour0001', start, ['info-1']);
  const snapshot = {
    id: 'rh:ingest', status: 'ready', scored: 1, candidates: 1, selected: 1,
    sections: [], items: [{
      nodeId: 'hit-1', title: '盘中消息', disposition: 'hit', readingDirectionName: '金融',
      timely: true, publishedAt: Date.parse('2026-10-15T18:21:00Z'), firstIngestedAt: start + 21 * 60_000,
    }],
  };
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage({
    session: () => ({ role: 'desktop', device: { id: 'ingest-clock' } }),
    active: () => true,
    loadTreeManifest: async () => manifest([current]),
    api(path) {
      if (path.startsWith('/api/v1/tags')) return Promise.resolve({ catalog: { tags: [] } });
      if (path.startsWith('/api/v1/reports/reading-hour')) return Promise.resolve({ snapshot });
      return Promise.reject(new Error('missing'));
    },
  });
  await page.mount(root, { mode: 'hourly' });
  const time = root.querySelector('.news-row-time');
  assert.match(time.textContent, /20:21/);
  assert.doesNotMatch(time.textContent, /02:21/);
  assert.equal(root.querySelector('.news-published-note').textContent, '发布于 02:21');
  page.stop();
});

function setHourMedia(mobile) {
  const fn = query => ({ matches: Boolean(mobile) && String(query).includes('max-width'), media: query, addEventListener() {}, removeEventListener() {} });
  window.matchMedia = fn;
  globalThis.matchMedia = fn;
}

test('hourly content follows the hour strip: left is newer, right is older', async () => {
  setHourMedia(true);
  const start = Date.parse('2026-10-08T06:00:00Z');
  const newest = edition('edition:swipehour0001', start, ['n1']);
  const middle = edition('edition:swipehour0002', start - HOUR, ['n2']);
  const oldest = edition('edition:swipehour0003', start - 2 * HOUR, ['n3']);
  const root = new El('div'); root.isConnected = true;
  const keys = [];
  const previousListen = document.addEventListener;
  document.addEventListener = (type, fn) => { keys.push({ type, fn }); previousListen.call(document, type, fn); };
  const page = createInformationTreePage(hostFor('hourly-swipe', () => manifest([newest, middle, oldest])));
  document.addEventListener = previousListen;
  await page.mount(root, { mode: 'hourly' });
  assert.deepEqual(chips(root).map(item => item.textContent), ['14:00', '13:00', '12:00']);
  const activeStart = () => chips(root).find(item => item.classList.contains('is-active')).dataset.start;
  const scrolled = [];
  for (const item of chips(root)) item.scrollIntoView = () => scrolled.push(item.dataset.start);
  const list = root.querySelector('.tree-list');
  async function swipe(dx, dy) {
    const x = 180, y = 220;
    let prevented = false;
    list.listeners.touchstart[0]({ touches: [{ clientX: x, clientY: y }] });
    list.listeners.touchmove[0]({
      touches: [{ clientX: x + dx, clientY: y + dy }],
      preventDefault() { prevented = true; },
    });
    await list.listeners.touchend[0]({ changedTouches: [{ clientX: x + dx, clientY: y + dy }] });
    return prevented;
  }
  assert.equal(await swipe(-80, 8), true);
  assert.equal(activeStart(), String(middle.window.startAt));
  assert.equal(scrolled.at(-1), String(middle.window.startAt));
  assert.equal(await swipe(-72, 6), true);
  assert.equal(activeStart(), String(oldest.window.startAt));
  assert.equal(await swipe(-90, 4), true);
  assert.equal(activeStart(), String(oldest.window.startAt));
  assert.equal(await swipe(80, 10), true);
  assert.equal(activeStart(), String(middle.window.startAt));
  assert.equal(await swipe(16, 90), false);
  assert.equal(activeStart(), String(middle.window.startAt));
  assert.equal(await swipe(55, 40), false);
  assert.equal(activeStart(), String(middle.window.startAt));

  const onKey = keys.find(item => item.type === 'keydown').fn;
  const key = (name, target, extra = {}) => onKey({ key: name, target, preventDefault() {}, ...extra });
  await key('ArrowLeft');
  assert.equal(activeStart(), String(newest.window.startAt));
  await key('ArrowLeft');
  assert.equal(activeStart(), String(newest.window.startAt));
  await key('ArrowRight', null, { ctrlKey: true });
  assert.equal(activeStart(), String(newest.window.startAt));
  await key('ArrowRight', root.querySelector('input'));
  assert.equal(activeStart(), String(newest.window.startAt));
  await key('ArrowRight');
  assert.equal(activeStart(), String(middle.window.startAt));

  let wheeled = false;
  const wheel = (deltaX, deltaY) => list.listeners.wheel[0]({
    deltaX, deltaY, preventDefault() { wheeled = true; },
  });
  wheeled = false;
  await wheel(10, 80);
  assert.equal(wheeled, false);
  assert.equal(activeStart(), String(middle.window.startAt));
  wheeled = false;
  await wheel(60, 8);
  assert.equal(wheeled, true);
  assert.equal(activeStart(), String(oldest.window.startAt));
  await wheel(80, 4);
  assert.equal(activeStart(), String(oldest.window.startAt));
  page.stop();
});

test('desktop right arrow moves to the next later hour', async () => {
  setHourMedia(false);
  const start = Date.parse('2026-10-08T06:00:00Z');
  const newest = edition('edition:deskhour000001', start, ['n1']);
  const middle = edition('edition:deskhour000002', start - HOUR, ['n2']);
  const oldest = edition('edition:deskhour000003', start - 2 * HOUR, ['n3']);
  const keys = [];
  const previousListen = document.addEventListener;
  document.addEventListener = (type, fn) => { keys.push({ type, fn }); previousListen.call(document, type, fn); };
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage(hostFor('hourly-desk', () => manifest([newest, middle, oldest])));
  document.addEventListener = previousListen;
  await page.mount(root, { mode: 'hourly' });
  await chip(root, middle.window.startAt).listeners.click[0]();
  await keys.find(item => item.type === 'keydown').fn({ key: 'ArrowRight', target: null, preventDefault() {} });
  assert.equal(chip(root, newest.window.startAt).classList.contains('is-active'), true);
  page.stop();
});

test('hour steps skip a run of missing editions', async () => {
  setHourMedia(false);
  const start = Date.parse('2026-10-08T08:00:00Z');
  const newest = edition('edition:gaphour0000001', start, ['n1']);
  const middle = edition('edition:gaphour0000002', start - HOUR, ['n2']);
  const oldest = edition('edition:gaphour0000003', start - 4 * HOUR, ['n3']);
  const keys = [];
  const previousListen = document.addEventListener;
  document.addEventListener = (type, fn) => { keys.push({ type, fn }); previousListen.call(document, type, fn); };
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage(hostFor('hourly-gap', () => manifest([newest, middle, oldest])));
  document.addEventListener = previousListen;
  await page.mount(root, { mode: 'hourly' });
  await chip(root, middle.window.startAt).listeners.click[0]();
  await keys.find(item => item.type === 'keydown').fn({ key: 'ArrowLeft', target: null, preventDefault() {} });
  assert.equal(chips(root).find(item => item.classList.contains('is-active')).dataset.start, String(oldest.window.startAt));
  const starts = chips(root).map(item => Number(item.dataset.start));
  assert.equal(starts.includes(start - 2 * HOUR), false);
  assert.equal(starts.includes(start - 3 * HOUR), false);
  assert.equal(root.querySelector('.tree-hour-gap').textContent, '13–14点');
  page.stop();
});

test('selecting an hour writes hour into the address', async () => {
  const start = Date.parse('2026-10-08T06:00:00Z');
  const current = edition('edition:hashhour000001', start, ['n1']);
  const urls = [];
  const previousLocation = globalThis.location;
  const previousHistory = globalThis.history;
  globalThis.location = { pathname: '/app', search: '', hash: '#report' };
  globalThis.history = {
    replaceState(_state, _title, url) {
      urls.push(String(url));
      globalThis.location.hash = String(url).slice(String(url).indexOf('#'));
    },
  };
  try {
    const root = new El('div'); root.isConnected = true;
    const page = createInformationTreePage(hostFor('hourly-hash', () => manifest([current])));
    await page.mount(root, { mode: 'hourly' });
    assert.match(urls.at(-1) || '', /#report\/2026-10-08\?hour=14$/);
    page.stop();
  } finally {
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousHistory === undefined) delete globalThis.history;
    else globalThis.history = previousHistory;
  }
});

test('an hour change asks the host to record history before replacing the address', async () => {
  const start = Date.parse('2026-10-08T06:00:00Z');
  const newer = edition('edition:hashhour000010', start, ['n1']);
  const older = edition('edition:hashhour000011', start - 3_600_000, ['n2']);
  const calls = [];
  const replaced = [];
  const previousLocation = globalThis.location;
  const previousHistory = globalThis.history;
  globalThis.location = { pathname: '/app', search: '', hash: '#report' };
  globalThis.history = {
    pushState(_state, _title, url) {
      globalThis.location.hash = String(url).slice(String(url).indexOf('#'));
    },
    replaceState(_state, _title, url) {
      replaced.push(String(url));
      globalThis.location.hash = String(url).slice(String(url).indexOf('#'));
    },
  };
  try {
    const root = new El('div'); root.isConnected = true;
    const page = createInformationTreePage({
      ...hostFor('hourly-history', () => manifest([newer, older])),
      syncHour(hour, extra) {
        calls.push({ hour, hash: extra.hash, node: extra.node });
        globalThis.history.pushState({ aiCenter: true }, '', `/app${extra.hash}`);
      },
    });
    await page.mount(root, { mode: 'hourly', node: 'n1' });
    assert.equal(calls[0].hour, 14);
    assert.equal(calls[0].hash, '#report/2026-10-08?hour=14&node=n1');
    assert.equal(calls.some((item) => item.hour === 14 && item.node === ''), true);
    assert.equal(replaced.length, 0);
    await chip(root, older.window.startAt).listeners.click[0]();
    assert.equal(calls.at(-1).hour, 13);
    assert.equal(calls.at(-1).hash, '#report/2026-10-08?hour=13');
    page.stop();
  } finally {
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    if (previousHistory === undefined) delete globalThis.history;
    else globalThis.history = previousHistory;
  }
});

test('reading hour index is requested inside the seven day window', async () => {
  const start = Date.parse('2026-10-08T03:00:00Z');
  const current = edition('edition:indexwindow01', start, ['n1']);
  const host = hostFor('hourly-index-window', () => manifest([current]));
  const calls = [];
  const api = host.api;
  host.api = path => { calls.push(path); return api(path); };
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage(host);
  await page.mount(root, { mode: 'hourly' });
  const path = calls.find(item => item.startsWith('/api/v1/reports/reading-hour/index'));
  const url = new URL(path, 'http://tree.local');
  const startAt = Number(url.searchParams.get('startAt'));
  const endAt = Number(url.searchParams.get('endAt'));
  assert.equal(url.searchParams.get('scope'), 'hour');
  assert.equal(Number.isInteger(startAt) && Number.isInteger(endAt) && endAt > startAt && endAt - startAt <= 7 * 86400000, true);
  page.stop();
});

test('a missing hour falls back to the nearest edition and says so', async () => {
  const start = Date.parse('2026-10-08T06:00:00Z');
  const current = edition('edition:fallbackhour01', start, ['n1']);
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage(hostFor('hourly-fallback', () => manifest([current])));
  await page.mount(root, { mode: 'hourly', hour: 15 });
  assert.equal(chip(root, start).classList.contains('is-active'), true);
  assert.equal(root.querySelector('.tree-hour-fallback').textContent, '15:00 那期还没生成，已显示 14:00');
  page.stop();
});

test('switching to a prefetched hour does not refetch or blank the list', async () => {
  const start = Date.parse('2026-10-08T06:00:00Z');
  const newest = edition('edition:prefetchhour01', start, ['n1']);
  const middle = edition('edition:prefetchhour02', start - HOUR, ['n2']);
  const calls = [];
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage({
    session: () => ({ role: 'desktop', device: { id: 'prefetch-hour' } }),
    active: () => true,
    loadTreeManifest: async () => manifest([newest, middle]),
    api(path) {
      if (path.startsWith('/api/v1/tags')) return Promise.resolve({ catalog: { tags: [] } });
      if (path.startsWith('/api/v1/reports/reading-hour/index')) {
        const error = new Error('not found'); error.status = 404; return Promise.reject(error);
      }
      if (path.startsWith('/api/v1/reports/reading-hour')) {
        calls.push(path);
        const startAt = Number(new URL(path, 'http://tree.local').searchParams.get('startAt'));
        const item = [newest, middle].find(row => row.window.startAt === startAt);
        return Promise.resolve({ snapshot: {
          id: `rh:${item.id}`, status: 'ready', scored: 1, candidates: 1, selected: 1,
          items: [{ nodeId: 'a', title: `标题${item.id}`, disposition: 'hit', readingDirectionName: '产业个股', readingThemeName: '中国', timely: true }],
        } });
      }
      return Promise.reject(new Error('missing'));
    },
  });
  await page.mount(root, { mode: 'hourly' });
  await new Promise(resolve => setTimeout(resolve, 30));
  const hits = path => calls.filter(item => item.includes(String(middle.window.startAt))).length;
  const before = hits();
  assert.equal(before, 1);
  const list = root.querySelector('.tree-list');
  let blanked = false;
  const original = list.replaceChildren.bind(list);
  list.replaceChildren = (...nodes) => {
    const mark = nodes.map(node => node?.className || '').join(' ');
    if (!nodes.length || mark.includes('tree-hour-skeleton')) blanked = true;
    return original(...nodes);
  };
  await page.selectHour(middle.window.startAt);
  assert.equal(hits(), before);
  assert.equal(blanked, false);
  assert.equal(root.querySelectorAll('h3').some(node => node.textContent.includes(middle.id)), true);
  page.stop();
});

test('source captions use publisher, account, or domain and skip an empty name', () => {
  assert.equal(sourceCaption({ publisher: '路透', title: '油价' }), '路透 · 油价');
  assert.equal(sourceCaption({ publisherName: '彭博', title: '油价' }), '彭博 · 油价');
  assert.equal(sourceCaption({ author: '张三', title: '油价' }), '张三 · 油价');
  assert.equal(sourceCaption({ provider: 'x', authorName: '油价观察', authorHandle: 'oilwatch', title: '油价' }), '@oilwatch · 油价');
  assert.equal(sourceCaption({ provider: 'twitter', handle: '@energy', title: '油价' }), '@energy · 油价');
  assert.equal(sourceCaption({ sourceUrl: 'https://www.reuters.com/world/oil', title: '油价' }), 'reuters.com · 油价');
  assert.equal(sourceCaption({ sourceUrl: 'https://x.com/oilwatch/status/1', title: '油价' }), '@oilwatch · 油价');
  assert.equal(sourceCaption({ provider: 'x', title: '油价' }), '油价');
  assert.equal(sourceCaption({ publisher: '未知', title: '油价' }), '油价');
  assert.equal(sourceCaption({ publisher: '来源', title: '油价' }), '油价');
  assert.equal(sourceCaption({ title: '油价' }), '油价');
});

test('hourly points open one source directly and lay out several sources', async () => {
  const start = Date.parse('2026-10-08T06:00:00Z');
  const current = edition('edition:sourcehour001', start, ['one', 'many']);
  const previous = edition('edition:sourcehour002', start - HOUR, ['older']);
  const nodes = {
    'info-one': { id: 'info-one', layer: 'information', title: '单来源标题', publisher: '路透', sourceRefs: [{ type: 'content-item', id: 'c1' }] },
    'src-a': { id: 'src-a', layer: 'information', title: '出口限制', publisher: '彭博', sourceRefs: [{ type: 'media-body', id: 'm2' }] },
    'src-b': { id: 'src-b', layer: 'information', title: '另一则很长的原文标题', publisher: '财新', sourceUrl: 'https://example.com/original' },
  };
  const reads = [];
  const opened = [];
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    const node = create(tag);
    if (String(tag).toLowerCase() === 'a') node.click = () => opened.push({ href: node.href, target: node.target, rel: node.rel });
    return node;
  };
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage({
    session: () => ({ role: 'desktop', device: { id: 'source-open' } }),
    active: () => true,
    readSavedSource: async node => { reads.push(node.id); },
    toast() {},
    loadTreeManifest: async () => manifest([current, previous]),
    api(path) {
      if (path.startsWith('/api/v1/tags')) return Promise.resolve({ catalog: { tags: [] } });
      if (path.startsWith('/api/v1/reports/reading-hour/index')) {
        const error = new Error('not found'); error.status = 404; return Promise.reject(error);
      }
      if (path.startsWith('/api/v1/reports/reading-hour')) {
        const startAt = Number(new URL(path, 'http://tree.local').searchParams.get('startAt'));
        if (startAt === previous.window.startAt) return Promise.resolve({ snapshot: { id: 'rh:old', status: 'ready', scored: 1, candidates: 1, selected: 1, items: [{ nodeId: 'older', title: '上一小时', disposition: 'hit', readingDirectionName: '产业个股', readingThemeName: '中国', timely: true }] } });
        return Promise.resolve({ snapshot: {
          id: 'rh:now', status: 'ready', scored: 2, candidates: 2, selected: 2,
          items: [
            { nodeId: 'info-one', title: '单来源要点', disposition: 'hit', readingDirectionName: '科技与AI', readingThemeName: '中国', timely: true },
            { nodeId: 'info-many', title: '多来源要点', disposition: 'hit', readingDirectionName: '科技与AI', readingThemeName: '中国', timely: true, sources: [
              { id: 'src-a', nodeId: 'src-a', publisher: '彭博', title: '出口限制', sourceRefs: [{ type: 'media-body', id: 'm2' }] },
              { id: 'src-b', nodeId: 'src-b', publisher: '财新', title: '另一则很长的原文标题', sourceUrl: 'https://example.com/original' },
            ] },
          ],
        } });
      }
      if (path.startsWith('/api/v1/reports/tree/node')) {
        const id = new URL(path, 'http://tree.local').searchParams.get('id');
        return Promise.resolve({ node: nodes[id] });
      }
      return Promise.reject(new Error(`missing ${path}`));
    },
  });
  await page.mount(root, { mode: 'hourly' });
  assert.equal(root.querySelectorAll('summary').some(node => node.textContent.includes('篇 · ref')), false);
  const single = root.querySelectorAll('.news-row').find(row => row.querySelector('h3').textContent === '单来源要点');
  const many = root.querySelectorAll('.news-row').find(row => row.querySelector('h3').textContent === '多来源要点');
  assert.equal(single.querySelector('.reading-ref'), null);
  assert.equal(single.querySelector('details').open, false);
  await single.querySelector('.news-row-body').listeners.click[0]({ target: single.querySelector('h3') });
  assert.equal(single.querySelector('details').open, true);
  assert.deepEqual(reads, []);
  const own = single.querySelector('.reading-fold-body').children.find(node => node.tagName === 'P');
  assert.match(own.textContent, /暂时读不到/);
  await single.querySelector('.news-row-body').listeners.click[0]({ target: single.querySelector('h3') });
  assert.equal(single.querySelector('details').open, false);
  const sourceRows = many.querySelectorAll('.reading-source-row');
  assert.deepEqual(sourceRows.map(row => row.textContent), ['彭博 · 出口限制', '财新 · 另一则很长的原文标题']);
  assert.equal(many.querySelector('details'), null);
  const jump = many.querySelector('.reading-source-jump');
  assert.equal(jump.textContent, '2 个来源 ↓');
  assert.equal(many.querySelectorAll('.reading-ref').length, 1);
  many.querySelector('.news-row-body').listeners.click[0]({ target: jump });
  assert.equal(many.querySelector('.reading-source-list').classList.contains('is-source-hit'), true);
  await sourceRows[0].listeners.click[0]();
  assert.deepEqual(reads, ['src-a']);
  await sourceRows[1].listeners.click[0]();
  assert.deepEqual(opened, [{ href: 'https://example.com/original', target: '_blank', rel: 'noopener' }]);
  const list = root.querySelector('.tree-list');
  const swipe = { touches: [{ clientX: 180, clientY: 220 }], stopped: false, stopPropagation() { this.stopped = true; } };
  sourceRows[0].listeners.touchstart[0](swipe);
  if (!swipe.stopped) list.listeners.touchstart[0](swipe);
  list.listeners.touchmove[0]({ touches: [{ clientX: 40, clientY: 222 }], cancelable: true, preventDefault() {} });
  await list.listeners.touchend[0]({ changedTouches: [{ clientX: 40, clientY: 222 }] });
  assert.equal(swipe.stopped, true);
  assert.equal(chip(root, current.window.startAt).classList.contains('is-active'), true);
  document.createElement = create;
  page.stop();
});

test('daily points open one source directly and lay out several sources', async () => {
  const start = Date.parse('2026-10-08T16:00:00Z');
  const issue = { id: 'edition:daily-source', layer: 'daily', window: { startAt: start, endAt: start + 24 * HOUR }, timezone: 'Asia/Shanghai', status: 'ready', roots: ['mod'], hasEditorial: true, generatedAt: start };
  const nodes = {
    n1: { id: 'n1', layer: 'information', title: '单来源标题', publisher: '路透', sourceRefs: [{ type: 'content-item', id: 'c1' }] },
    n2: { id: 'n2', layer: 'information', title: '甲事件', sourceRefs: [{ type: 'content-item', id: 'x-post' }] },
    n3: { id: 'n3', layer: 'information', title: '乙事件原文标题很长', sourceUrl: 'https://www.example.com/daily' },
  };
  const reads = [];
  const opened = [];
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    const node = create(tag);
    if (String(tag).toLowerCase() === 'a') node.click = () => opened.push({ href: node.href, target: node.target, rel: node.rel });
    return node;
  };
  const editorial = {
    id: 'ed-1', status: 'ready', statusNote: '已覆盖', overview: '总览',
    coverage: { hourlyModuleCount: 1, informationNodeCount: 3, eventCount: 2, inBodyEventCount: 2, indexOnlyEventCount: 0 },
    relations: [],
    events: [
      { eventId: 'e1', sourceNodeIds: ['n1'] },
      { eventId: 'e2', sourceNodeIds: ['n2', 'n3'] },
    ],
    articles: [{
      direction: 'tech', title: '芯片', lead: '导语只有一个来源。', leadEventIds: ['e1'],
      sections: [{ heading: '主题', paragraphs: ['这一段有两个来源。'], eventIds: ['e2'], kind: 'theme' }],
    }],
  };
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage({
    session: () => ({ role: 'desktop', device: { id: 'daily-source' } }),
    active: () => true,
    readSavedSource: async node => { reads.push(node.id); },
    toast() {},
    loadTreeManifest: async () => ({ timezone: 'Asia/Shanghai', directions: {}, hours: [], days: [{ edition: issue }], information: [] }),
    api(path) {
      if (path.startsWith('/api/v1/tags')) return Promise.resolve({ catalog: { tags: [] } });
      if (path.startsWith('/api/v1/reports/tree/editorial')) return Promise.resolve({ editorial });
      if (path.startsWith('/api/v1/reports/tree/node')) {
        const id = new URL(path, 'http://tree.local').searchParams.get('id');
        return Promise.resolve({ node: nodes[id] });
      }
      if (path.startsWith('/api/v1/content-items/')) return Promise.resolve({ item: { provider: 'x', authorName: '油价观察', captureMetadata: { authorHandle: 'oilwatch' }, sourceUrl: 'https://x.com/oilwatch/status/1', title: '原帖' } });
      return Promise.reject(new Error(`missing ${path}`));
    },
  });
  await page.mount(root);
  const card = root.querySelector('.daily-direction-card');
  assert.ok(card);
  await card.listeners.click[0]();
  assert.equal(root.querySelector('.daily-proof'), null);
  assert.equal(root.querySelectorAll('summary').some(node => node.textContent.includes('篇 · ref')), false);
  const lead = root.querySelector('.is-direct-source');
  assert.equal(lead.querySelector('.reading-ref').textContent, '〔1〕');
  await lead.listeners.click[0]();
  assert.deepEqual(reads, ['n1']);
  const section = root.querySelector('.daily-section');
  const sourceRows = section.querySelectorAll('.reading-source-row');
  for (let i = 0; i < 8 && sourceRows[0].textContent !== '@oilwatch · 甲事件'; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(sourceRows.map(row => row.textContent), ['@oilwatch · 甲事件', 'example.com · 乙事件原文标题很长']);
  const jump = section.querySelector('.reading-source-jump');
  assert.equal(jump.textContent, '2 个来源 ↓');
  assert.equal(section.querySelectorAll('.reading-ref').filter(node => node.textContent.startsWith('〔')).length, 0);
  jump.listeners.click[0]({ stopPropagation() {} });
  assert.equal(section.querySelector('.reading-source-list').classList.contains('is-source-hit'), true);
  await sourceRows[0].listeners.click[0]();
  assert.deepEqual(reads, ['n1', 'n2']);
  await sourceRows[1].listeners.click[0]();
  assert.deepEqual(opened, [{ href: 'https://www.example.com/daily', target: '_blank', rel: 'noopener' }]);
  document.createElement = create;
  page.stop();
});

test('a daily module lists its sources instead of a ref menu', async () => {
  const start = Date.parse('2026-10-08T16:00:00Z');
  const issue = { id: 'edition:daily-module', layer: 'daily', window: { startAt: start, endAt: start + 24 * HOUR }, timezone: 'Asia/Shanghai', status: 'ready', roots: ['mod-one', 'mod-many'], hasEditorial: false, generatedAt: start };
  const leaves = {
    only: { id: 'only', layer: 'information', title: '唯一原文', publisher: '路透', text: '一点', sourceRefs: [{ type: 'content-item', id: 'c1' }] },
    'leaf-a': { id: 'leaf-a', layer: 'information', title: '甲稿', publisher: '路透', sourceRefs: [{ type: 'content-item', id: 'c2' }] },
    'leaf-b': { id: 'leaf-b', layer: 'information', title: '乙稿', publisher: '财新', sourceRefs: [{ type: 'content-item', id: 'c3' }] },
  };
  const modules = {
    'mod-one': { id: 'mod-one', layer: 'daily', title: '单模块', text: '只有一篇', tagId: 'ai', children: ['only'] },
    'mod-many': { id: 'mod-many', layer: 'daily', title: '多模块', text: '有两篇', tagId: 'ai', children: ['leaf-a', 'leaf-b'] },
  };
  const reads = [];
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage({
    session: () => ({ role: 'desktop', device: { id: 'daily-module' } }),
    active: () => true,
    readSavedSource: async node => { reads.push(node.id); },
    toast() {},
    loadTreeManifest: async () => ({ timezone: 'Asia/Shanghai', directions: {}, hours: [], days: [{ edition: issue }], information: [] }),
    api(path) {
      if (path.startsWith('/api/v1/tags')) return Promise.resolve({ catalog: { tags: [] } });
      if (path.startsWith('/api/v1/reports/tree/edition')) return Promise.resolve({ edition: issue, nodes: [modules['mod-one'], modules['mod-many']] });
      if (path.startsWith('/api/v1/reports/tree/children')) {
        const id = new URL(path, 'http://tree.local').searchParams.get('id');
        const kids = { 'mod-one': [leaves.only], 'mod-many': [leaves['leaf-a'], leaves['leaf-b']] };
        return Promise.resolve({ children: kids[id] || [] });
      }
      if (path.startsWith('/api/v1/reports/tree/node')) {
        const id = new URL(path, 'http://tree.local').searchParams.get('id');
        return Promise.resolve({ node: leaves[id] || modules[id] });
      }
      return Promise.reject(new Error(`missing ${path}`));
    },
  });
  await page.mount(root);
  const openRow = title => root.querySelectorAll('.news-row').find(row => row.querySelector('h3').textContent === title).querySelector('.news-row-body');
  await openRow('多模块').listeners.click[0]();
  assert.equal(root.querySelectorAll('summary').some(node => node.textContent.includes('篇 · ref')), false);
  assert.deepEqual(root.querySelectorAll('.reading-source-row').map(row => row.textContent), ['路透 · 甲稿', '财新 · 乙稿']);
  const back = root.querySelectorAll('button').find(node => node.querySelectorAll('span').some(span => span.textContent === '返回日报'));
  await back.listeners.click[0]();
  await openRow('单模块').listeners.click[0]();
  const card = root.querySelector('.tree-card');
  await card.querySelector('h3').listeners.click[0]();
  await card.querySelector('.reading-ref').listeners.click[0]({ stopPropagation() {} });
  assert.deepEqual(reads, ['only', 'only']);
  assert.equal(root.querySelectorAll('summary').some(node => node.textContent.includes('篇 · ref')), false);
  const detailShare = card.querySelector('.news-share');
  assert.equal(detailShare.textContent, '分享');
  page.stop();
});

test('hourly share uses the item title and summary, not the first source', async () => {
  const start = Date.parse('2026-10-08T06:00:00Z');
  const current = edition('edition:shareshour001', start, ['kospi']);
  const shared = [];
  const reads = [];
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage({
    session: () => ({ role: 'desktop', device: { id: 'hourly-share' } }),
    active: () => true,
    shareCard: (input) => { shared.push(input); },
    readSavedSource: async (node) => { reads.push(node.id); },
    loadTreeManifest: async () => manifest([current]),
    api(path) {
      if (path.startsWith('/api/v1/tags')) return Promise.resolve({ catalog: { tags: [] } });
      if (path.startsWith('/api/v1/reports/reading-hour')) return Promise.resolve({ snapshot: {
        id: 'rh:share', status: 'ready', scored: 1, candidates: 1, selected: 1,
        items: [{ nodeId: 'kospi', title: 'KOSPI 触及两个月新低', disposition: 'hit', readingDirectionName: '金融', readingThemeName: '韩国', timely: true }],
      } });
      if (path.startsWith('/api/v1/reports/tree/node')) return Promise.resolve({ node: {
        id: 'kospi', layer: 'information', title: 'KOSPI 触及两个月新低',
        text: '小时摘要 [未抓取] 图片 ×2',
        body: '韩指已经两个月新低 [未抓取] 图片 ×2',
        sourceRefs: [{ type: 'content-item', id: 'raw-post' }],
      } });
      return Promise.reject(new Error(`missing ${path}`));
    },
  });
  await page.mount(root, { mode: 'hourly' });
  const row = root.querySelector('.news-row');
  assert.equal(row.querySelector('h3').textContent, 'KOSPI 触及两个月新低');
  assert.equal(row.querySelector('.news-share'), null);
  assert.equal(row.querySelector('.news-tag'), null);
  const fold = row.querySelector('details');
  fold.open = true;
  await fold.listeners.toggle[0]();
  assert.equal(row.querySelector('.reading-fold-body').querySelector('.news-tag').textContent, '韩国');
  const share = row.querySelector('.reading-fold-body').querySelector('.news-share');
  assert.equal(share.textContent, '分享');
  await share.listeners.click[0]({ stopPropagation() {}, preventDefault() {} });
  for (let i = 0; i < 8 && !shared.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(shared.length, 1);
  assert.equal(shared[0].title, 'KOSPI 触及两个月新低');
  assert.equal(shared[0].source, '小时报');
  assert.deepEqual(shared[0].paragraphs, ['小时摘要']);
  assert.equal(reads.length, 0);
  page.stop();
});

test('hourly section rows sort and label by ingest time', async () => {
  const start = Date.parse('2026-10-08T04:00:00Z');
  const current = edition('edition:publishtime01', start, ['early']);
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage({
    session: () => ({ role: 'desktop', device: { id: 'publish-time' } }),
    active: () => true,
    loadTreeManifest: async () => manifest([current]),
    api(path) {
      if (path.startsWith('/api/v1/tags')) return Promise.resolve({ catalog: { tags: [] } });
      if (path.startsWith('/api/v1/reports/reading-hour')) return Promise.resolve({ snapshot: {
        id: 'rh:time', status: 'ready', scored: 3, candidates: 3, selected: 3,
        items: [
          { nodeId: 'early', title: '先收录', disposition: 'hit', readingDirectionName: '金融', readingThemeName: '中国', publishedAt: start + 40 * 60_000, firstIngestedAt: start + 10 * 60_000, timely: true },
          { nodeId: 'late', title: '后收录', disposition: 'hit', readingDirectionName: '金融', readingThemeName: '中国', publishedAt: start + 10 * 60_000, firstIngestedAt: start + 40 * 60_000, timely: true },
          { nodeId: 'missing', title: '没有发布时间', disposition: 'hit', readingDirectionName: '金融', readingThemeName: '中国', publishedAt: null, firstIngestedAt: start + 50 * 60_000, timely: true },
        ],
      } });
      return Promise.reject(new Error('missing'));
    },
  });
  await page.mount(root, { mode: 'hourly' });
  assert.deepEqual(root.querySelectorAll('h3').map((node) => node.textContent), ['没有发布时间', '后收录', '先收录']);
  assert.deepEqual(root.querySelectorAll('time').map((node) => node.textContent), ['10月8日 12:50', '10月8日 12:40', '10月8日 12:10']);
  assert.equal(root.querySelector('.news-share'), null);
  assert.equal(root.querySelector('.news-tag'), null);
  assert.equal(root.querySelector('.news-row-source'), null);
  page.stop();
});

test('daily bullets have a share entry on the list and the detail', async () => {
  const start = Date.parse('2026-10-08T16:00:00Z');
  const issue = { id: 'edition:daily-share', layer: 'daily', window: { startAt: start, endAt: start + 24 * HOUR }, timezone: 'Asia/Shanghai', status: 'ready', roots: ['mod'], hasEditorial: true, generatedAt: start };
  const shared = [];
  const editorial = {
    id: 'ed-share', status: 'ready', statusNote: '已覆盖', overview: '总览',
    coverage: { hourlyModuleCount: 1, informationNodeCount: 1, eventCount: 1, inBodyEventCount: 1, indexOnlyEventCount: 0 },
    relations: [],
    events: [{ eventId: 'e1', sourceNodeIds: [] }],
    articles: [{
      direction: 'tech', title: '芯片单条', lead: '导语 [未抓取]', leadEventIds: [],
      sections: [{ heading: '主题', paragraphs: ['这一段。'], eventIds: [], kind: 'theme' }],
    }],
  };
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage({
    session: () => ({ role: 'desktop', device: { id: 'daily-share' } }),
    active: () => true,
    shareCard: (input) => { shared.push(input); },
    toast() {},
    loadTreeManifest: async () => ({ timezone: 'Asia/Shanghai', directions: {}, hours: [], days: [{ edition: issue }], information: [] }),
    api(path) {
      if (path.startsWith('/api/v1/tags')) return Promise.resolve({ catalog: { tags: [] } });
      if (path.startsWith('/api/v1/reports/tree/editorial')) return Promise.resolve({ editorial });
      return Promise.reject(new Error(`missing ${path}`));
    },
  });
  await page.mount(root);
  const listShare = root.querySelector('.news-share');
  assert.equal(listShare.textContent, '分享');
  await listShare.listeners.click[0]({ stopPropagation() {} });
  assert.equal(shared[0].title, '芯片单条');
  assert.equal(shared[0].source, '日报');
  assert.deepEqual(shared[0].paragraphs, ['导语', '主题', '这一段。']);
  await root.querySelector('.daily-direction-card').listeners.click[0]();
  const detailShare = root.querySelector('.daily-detail-head').querySelector('.news-share');
  assert.equal(detailShare.textContent, '分享');
  await detailShare.listeners.click[0]({ stopPropagation() {} });
  assert.equal(shared.length, 2);
  assert.equal(shared[1].title, '芯片单条');
  page.stop();
});

function flatNodes(node, out = []) {
  if (!node?.tagName) return out;
  out.push(node);
  for (const child of node.children || []) flatNodes(child, out);
  return out;
}

function dailyIssue(id, start, roots, hasEditorial) {
  return {
    id, layer: 'daily', window: { startAt: start, endAt: start + 24 * HOUR }, timezone: 'Asia/Shanghai',
    status: 'ready', roots, hasEditorial, generatedAt: start,
  };
}

function southboundHost(issue, { editorial = null, nodes = [], directions = {} } = {}) {
  return {
    session: () => ({ role: 'desktop', device: { id: 'southbound-section' } }),
    active: () => true,
    toast() {},
    loadTreeManifest: async () => ({ timezone: 'Asia/Shanghai', directions, hours: [], days: [{ edition: issue }], information: [] }),
    api(path) {
      if (path.startsWith('/api/v1/tags')) return Promise.resolve({ catalog: { tags: [] } });
      if (path.startsWith('/api/v1/reports/tree/editorial')) return Promise.resolve({ editorial });
      if (path.startsWith('/api/v1/reports/tree/edition')) return Promise.resolve({ edition: issue, nodes });
      return Promise.reject(new Error(`missing ${path}`));
    },
  };
}

test('southbound stays at the end of a daily that has no finance section', async () => {
  const start = Date.parse('2026-10-08T16:00:00Z');
  const issue = dailyIssue('edition:daily-no-finance', start, ['mod'], true);
  const editorial = {
    id: 'ed-no-finance', status: 'ready', statusNote: '已覆盖', overview: '今天没有市场成稿',
    coverage: { hourlyModuleCount: 1, informationNodeCount: 2, eventCount: 2, inBodyEventCount: 2, indexOnlyEventCount: 0 },
    relations: [], events: [],
    articles: [
      { direction: 'policy', title: '政策标题', lead: '政策导语', leadEventIds: [], sections: [{ heading: '时事', paragraphs: ['政策正文'], eventIds: [], kind: 'theme' }] },
      { direction: 'tech', title: '科技标题', lead: '科技导语', leadEventIds: [], sections: [{ heading: '产业', paragraphs: ['科技正文'], eventIds: [], kind: 'theme' }] },
    ],
  };
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage(southboundHost(issue, { editorial }));
  await page.mount(root);
  const research = root.querySelector('.daily-research');
  const line = research.querySelector('.southbound-daily-line');
  assert.equal(research.querySelectorAll('.southbound-daily-line').length, 1);
  assert.equal(research.children[0].classList.contains('daily-overview'), true);
  assert.equal(research.children.at(-1), line);
  assert.ok(flatNodes(research).findIndex((node) => node.tagName === 'H3') < flatNodes(research).indexOf(line));
  await research.querySelector('.daily-direction-card').listeners.click[0]();
  const opened = root.querySelector('.daily-research');
  const openedLine = opened.querySelector('.southbound-daily-line');
  assert.equal(opened.querySelectorAll('.southbound-daily-line').length, 1);
  assert.equal(opened.children[0].classList.contains('daily-detail-head'), true);
  assert.equal(opened.children.at(-1), openedLine);
  assert.equal(opened.querySelector('h3').textContent, '政策标题');
  page.stop();
});

test('southbound stays after the news when none of the items are finance', async () => {
  const start = Date.parse('2026-10-08T16:00:00Z');
  const issue = dailyIssue('edition:daily-no-finance-news', start, ['policy-mod', 'tech-mod'], false);
  const nodes = [
    { id: 'policy-mod', layer: 'daily', title: '政策新闻', text: '一条', tagId: 'geopolitics' },
    { id: 'tech-mod', layer: 'daily', title: '科技新闻', text: '另一条', tagId: 'ai' },
  ];
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage(southboundHost(issue, { nodes, directions: { geopolitics: 'policy', ai: 'tech' } }));
  await page.mount(root);
  const feed = root.querySelector('.daily-news');
  const titles = feed.querySelectorAll('h3').map((node) => node.textContent);
  assert.deepEqual(titles, ['政策新闻', '科技新闻']);
  assert.equal(feed.children[0].classList.contains('news-rows'), true);
  assert.equal(feed.children.at(-1).classList.contains('southbound-daily-line'), true);
  assert.equal(feed.querySelectorAll('.southbound-daily-line').length, 1);
  assert.ok(flatNodes(feed).findIndex((node) => node.classList.contains('news-row-title')) < flatNodes(feed).findIndex((node) => node.classList.contains('southbound-daily-line')));
  page.stop();
});

test('an empty daily keeps the note first and southbound after it', async () => {
  const start = Date.parse('2026-10-08T16:00:00Z');
  const issue = dailyIssue('edition:daily-empty', start, [], false);
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage(southboundHost(issue));
  await page.mount(root);
  const feed = root.querySelector('.daily-news');
  assert.equal(feed.children[0].textContent, '这一天还没有日报。');
  assert.equal(feed.children[1].classList.contains('southbound-daily-line'), true);
  assert.equal(feed.querySelectorAll('.southbound-daily-line').length, 1);
  page.stop();
});

test('a finance article without an A-share heading still keeps southbound under the first section', async () => {
  const start = Date.parse('2026-10-08T16:00:00Z');
  const issue = dailyIssue('edition:daily-no-ashare', start, ['mod'], true);
  const editorial = {
    id: 'ed-no-ashare', status: 'ready', statusNote: '已覆盖', overview: '市场成稿没有 A 股标题',
    coverage: { hourlyModuleCount: 1, informationNodeCount: 1, eventCount: 1, inBodyEventCount: 1, indexOnlyEventCount: 0 },
    relations: [], events: [],
    articles: [{
      direction: 'finance', title: '金融与市场', lead: '市场导语', leadEventIds: [],
      sections: [
        { heading: '港股', paragraphs: ['港股正文'], eventIds: [], kind: 'theme' },
        { heading: '美债', paragraphs: ['美债正文'], eventIds: [], kind: 'theme' },
      ],
    }],
  };
  const root = new El('div'); root.isConnected = true;
  const page = createInformationTreePage(southboundHost(issue, { editorial }));
  await page.mount(root);
  const research = root.querySelector('.daily-research');
  const stack = research.querySelector('.daily-direction-stack');
  assert.equal(research.children[0].classList.contains('daily-overview'), true);
  assert.equal(stack.children[0].classList.contains('daily-direction-card'), true);
  assert.equal(stack.children[1].classList.contains('southbound-daily-line'), true);
  await stack.querySelector('.daily-direction-card').listeners.click[0]();
  const opened = root.querySelector('.daily-research');
  const section = opened.querySelector('.daily-section');
  assert.equal(opened.children[0].classList.contains('daily-detail-head'), true);
  assert.equal(section.querySelector('h4').textContent, '港股');
  assert.equal(section.children[1].classList.contains('southbound-daily-line'), true);
  assert.equal(opened.querySelectorAll('.daily-section')[1].querySelector('.southbound-daily-line'), null);
  assert.equal(opened.querySelectorAll('.southbound-daily-line').length, 1);
  page.stop();
});

function hourCalls(calls, startAt) {
  return calls.filter((path) => path.startsWith('/api/v1/reports/reading-hour?') && path.includes(`startAt=${startAt}`));
}

async function stepToEarlier(root, mobile) {
  if (!mobile) return root.querySelector('[aria-label="上一期"]').listeners.click[0]();
  const list = root.querySelector('.tree-list');
  const x = 180;
  const y = 220;
  list.listeners.touchstart[0]({ touches: [{ clientX: x, clientY: y }] });
  list.listeners.touchmove[0]({ touches: [{ clientX: x - 80, clientY: y + 8 }], preventDefault() {} });
  return list.listeners.touchend[0]({ changedTouches: [{ clientX: x - 80, clientY: y + 8 }] });
}

async function stepToLater(root, mobile) {
  if (!mobile) return root.querySelector('[aria-label="下一期"]').listeners.click[0]();
  const list = root.querySelector('.tree-list');
  const x = 180;
  const y = 220;
  list.listeners.touchstart[0]({ touches: [{ clientX: x, clientY: y }] });
  list.listeners.touchmove[0]({ touches: [{ clientX: x + 80, clientY: y + 8 }], preventDefault() {} });
  return list.listeners.touchend[0]({ changedTouches: [{ clientX: x + 80, clientY: y + 8 }] });
}

test('desktop and phone empty hours stay quiet while neighbors still load', async () => {
  const start = Date.parse('2026-10-08T06:00:00Z');
  const filled = edition('edition:filledhour0001', start, ['n1']);
  const blank = edition('edition:blankhour00001', start - HOUR, ['n2']);
  const filledBody = {
    snapshot: {
      id: 'rh:filled', status: 'ready', scored: 1, candidates: 1, selected: 1,
      items: [{ nodeId: 'n1', title: '有内容的小时', disposition: 'hit', readingDirectionName: '产业个股', readingThemeName: '中国', timely: true }],
    },
  };
  const emptyBody = { ok: true, empty: true, snapshot: null, message: '这一小时没有内容' };
  async function open(mobile, blankResponse) {
    setHourMedia(mobile);
    const calls = [];
    const toasts = [];
    const root = new El('div');
    root.isConnected = true;
    const page = createInformationTreePage({
      session: () => ({ role: mobile ? 'phone' : 'desktop', device: { id: mobile ? 'phone-empty' : 'desk-empty' } }),
      active: () => true,
      toast(text) { toasts.push(text); },
      loadTreeManifest: async () => manifest([filled, blank]),
      api(path) {
        calls.push(path);
        if (path.startsWith('/api/v1/tags')) return Promise.resolve({ catalog: { tags: [] } });
        if (path.startsWith('/api/v1/reports/reading-hour/index')) return Promise.resolve({ hours: [] });
        if (path.startsWith('/api/v1/reports/reading-hour')) {
          const startAt = Number(new URL(path, 'http://tree.local').searchParams.get('startAt'));
          if (startAt === blank.window.startAt) return blankResponse();
          return Promise.resolve(filledBody);
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      },
    });
    await page.mount(root, { mode: 'hourly' });
    assert.equal(root.querySelector('h3').textContent, '有内容的小时');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(hourCalls(calls, blank.window.startAt).length >= 1, true);
    assert.equal(root.querySelector('h3').textContent, '有内容的小时');
    const prefetched = hourCalls(calls, blank.window.startAt).length;
    await stepToEarlier(root, mobile);
    assert.equal(root.querySelector('.tree-hour-empty').textContent, '本小时暂无入料');
    assert.equal(root.querySelector('h3'), null);
    assert.equal(root.querySelectorAll('button').some((item) => String(item.textContent).includes('读取失败')), false);
    assert.deepEqual(toasts, []);
    await stepToLater(root, mobile);
    assert.equal(root.querySelector('h3').textContent, '有内容的小时');
    assert.equal(hourCalls(calls, filled.window.startAt).length >= 1, true);
    assert.equal(hourCalls(calls, blank.window.startAt).length, prefetched);
    page.stop();
  }
  const quietEmpty = () => Promise.resolve(emptyBody);
  await open(false, quietEmpty);
  await open(true, quietEmpty);
  const legacyMiss = () => Promise.reject(Object.assign(new Error('请求失败 (404)'), { status: 404 }));
  await open(false, legacyMiss);
  await open(true, legacyMiss);
});
