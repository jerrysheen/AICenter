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

const { createInformationTreePage } = await import('../apps/web/public/information-tree.js');

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
  assert.equal(chip(root, previous.window.startAt).getAttribute('aria-label'), '上个小时，未读');
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
  assert.equal(chip(root, start + HOUR).textContent, '这个小时');
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
  assert.equal(root.querySelectorAll('p').some(item => item.textContent === '读取失败，请重试。'), true);

  state.fail = false;
  const retry = root.querySelectorAll('button').find(item => item.textContent === '重试读取');
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
      const id = new URL(path, 'http://tree.local').searchParams.get('id');
      if (id === current.id) return Promise.resolve({ edition: current, nodes: [info] });
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
  assert.equal(headings.includes('其他'), true);
  assert.equal(root.querySelectorAll('button').some(node => node.textContent === '关注精选'), false);
  assert.equal(root.querySelectorAll('h3').some(node => node.textContent.includes('范围外讣告')), false);
  assert.equal(root.querySelector('.reading-stale').textContent, '时效不足');
  const titles = root.querySelectorAll('h3').map(node => node.textContent);
  assert.ok(titles.includes('命中标题'));
  assert.ok(titles.includes('未命中旧闻'));
  page.stop();
});

test('hourly content follows the hour strip: left is newer, right is older', async () => {
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
  assert.deepEqual(chips(root).map(item => item.textContent), ['这个小时', '上个小时', '上上个小时']);
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
