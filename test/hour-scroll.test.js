import test from 'node:test';
import assert from 'node:assert/strict';
import { reportViewOwnsScroll } from '../apps/web/public/report-history.js';

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
  get childElementCount() { return this.children.length; }
  getBoundingClientRect() {
    return rects.get(this.dataset.nodeId) || { top: 0, bottom: 0 };
  }
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
  if (selector.includes(',')) return selector.split(',').some(part => matches(node, part.trim()));
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
  if (!attr) return node.tagName === selector.toUpperCase();
  const key = attr[1].replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (attr[2] === undefined) return node.dataset[key] !== undefined || node.attrs[attr[1]] !== undefined;
  return attr[1].startsWith('data-') ? node.dataset[key] === attr[2] : node.attrs[attr[1]] === attr[2];
}

const rects = new Map();
const frames = [];
const memory = new Map();
globalThis.Option = function Option(text, value) { const node = new El('option'); node.textContent = text; node.value = value; return node; };
globalThis.document = {
  hidden: false,
  addEventListener() {},
  createElement: tag => new El(tag),
  querySelectorAll() { return []; },
};
globalThis.window = {
  scrollY: 0,
  listeners: {},
  scrollTo(options) {
    const top = typeof options === 'number' ? options : Number(options?.top);
    if (Number.isFinite(top)) this.scrollY = top;
  },
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  removeEventListener() {},
  dispatchEvent(event) { for (const fn of this.listeners[event.type] || []) fn(event); },
};
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
globalThis.localStorage = {
  getItem: key => memory.has(key) ? memory.get(key) : null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: key => memory.delete(key),
};

const { createInformationTreePage } = await import('../apps/web/public/information-tree.js');
const { createBriefPage } = await import('../apps/web/public/brief-page.js');

const HOUR = 3_600_000;
function edition(id, start, roots) {
  return { id, layer: 'hourly', window: { startAt: start, endAt: start + HOUR }, timezone: 'Asia/Shanghai', status: 'ready', roots, inputIds: roots, pendingIds: [], missingHours: [], generatedAt: start + 1000 };
}
function manifest(hours) {
  return { pipeline: 'tree-v3', timezone: 'Asia/Shanghai', directions: {}, hours: hours.map(item => ({ edition: item })), days: [], information: [] };
}
function flush() {
  for (let guard = 0; guard < 8 && frames.length; guard += 1) {
    const batch = frames.splice(0, frames.length);
    for (const fn of batch) fn();
  }
}
function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= 1, `scroll ${actual} expected ${expected}`);
}

const article = {
  id: 'info-one', layer: 'information', title: '单来源标题', text: '正文', body: '正文全文',
  sourceRefs: [{ type: 'content-item', id: 'c1' }],
};

function treeHost(hours, state = {}) {
  return {
    session: () => ({ role: 'desktop', device: { id: 'hour-scroll' } }),
    active: () => state.active !== false,
    readSavedSource: async () => { state.reads = (state.reads || 0) + 1; },
    loadTreeManifest: async () => manifest(hours()),
    api(path) {
      if (path.startsWith('/api/v1/tags')) return Promise.resolve({ catalog: { tags: [] } });
      if (path.startsWith('/api/v1/reports/reading-hour/index')) {
        const error = new Error('not found'); error.status = 404; return Promise.reject(error);
      }
      if (path.startsWith('/api/v1/reports/tree/node')) {
        return Promise.resolve({ node: article });
      }
      if (path.startsWith('/api/v1/content-items/')) return Promise.resolve({ item: {} });
      if (path.startsWith('/api/v1/reports/reading-hour')) {
        const startAt = Number(new URL(path, 'http://tree.local').searchParams.get('startAt'));
        const item = hours().find(row => row.window.startAt === startAt);
        if (!item) { const error = new Error('missing'); error.status = 404; return Promise.reject(error); }
        const refresh = state.refresh;
        if (refresh && startAt === refresh.startAt) return refresh.next();
        return Promise.resolve(snapshotFor(item));
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    },
  };
}

function snapshotFor(item, extra = {}) {
  return {
    snapshot: {
      id: extra.id || `rh:${item.id}`,
      status: extra.status || 'ready',
      scored: 1, candidates: 1, selected: 1,
      items: [{ nodeId: item.roots[0], title: '标题', disposition: 'hit', readingDirectionName: '产业个股', readingThemeName: '中国', timely: true }],
    },
  };
}

async function mountHour(hours, options = {}) {
  const root = new El('div');
  root.isConnected = true;
  const page = createInformationTreePage(treeHost(() => hours, options.state || {}));
  await page.mount(root, { mode: 'hourly', ...(options.mount || {}) });
  flush();
  return { root, page };
}

async function expandAndOpen(root) {
  const fold = root.querySelector('.reading-fold');
  assert.ok(fold);
  fold.open = true;
  await fold.listeners.toggle[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  const original = root.querySelector('[data-behavior="source.original"]');
  assert.equal(original.textContent, '原文');
  await original.listeners.click[0]();
  return fold;
}

test('opening the original and coming back keeps the hour scroll and the open item', async () => {
  const start = Date.parse('2026-10-08T06:00:00Z');
  const current = edition('edition:scrollhour001', start, ['info-one']);
  const state = {};
  const { root, page } = await mountHour([current], { state });
  try {
    window.scrollY = 640;
    const fold = await expandAndOpen(root);
    assert.equal(state.reads, 1);
    assert.equal(fold.open, true);
    page.suspend();
    window.scrollY = 0;
    assert.equal(page.hasHourScroll(), true);
    assert.equal(reportViewOwnsScroll('report', page.hasHourScroll()), true);
    const list = root.querySelector('.tree-list');
    let replaced = false;
    const originalReplace = list.replaceChildren.bind(list);
    list.replaceChildren = (...nodes) => { replaced = true; return originalReplace(...nodes); };
    await page.selectHour(14);
    flush();
    near(window.scrollY, 640);
    assert.equal(root.querySelector('.reading-fold').open, true);
    assert.equal(replaced, false);
  } finally {
    page.stop();
  }
});

test('system back and the page back button both restore the same hour', async () => {
  const start = Date.parse('2026-10-08T06:00:00Z');
  const current = edition('edition:scrollhour002', start, ['info-one']);
  const root = new El('div');
  root.isConnected = true;
  const reads = [];
  const brief = createBriefPage({
    session: () => ({ role: 'desktop', device: { id: 'hour-scroll-brief' } }),
    active: () => true,
    readSavedSource: async () => { reads.push('original'); },
    api(path) {
      if (path.startsWith('/api/v1/tags')) return Promise.resolve({ catalog: { tags: [] } });
      if (path.startsWith('/api/v1/reports/reading-hour/index')) {
        const error = new Error('not found'); error.status = 404; return Promise.reject(error);
      }
      if (path.startsWith('/api/v1/reports/tree/node')) return Promise.resolve({ node: article });
      if (path.startsWith('/api/v1/content-items/')) return Promise.resolve({ item: {} });
      if (path.startsWith('/api/v1/reports/reading-hour')) return Promise.resolve(snapshotFor(current));
      if (path.startsWith('/api/v1/reports/tree')) return Promise.resolve(manifest([current]));
      return Promise.reject(new Error(`unexpected ${path}`));
    },
  });
  await brief.mount(root, { hour: 14 });
  try {
    flush();
    window.scrollY = 480;
    await expandAndOpen(root);
    const list = root.querySelector('.tree-list');
    for (const label of ['系统返回', '返回按钮']) {
      brief.stop();
      window.scrollY = 12;
      let replaced = false;
      const originalReplace = list.replaceChildren.bind(list);
      list.replaceChildren = (...nodes) => { replaced = true; return originalReplace(...nodes); };
      await brief.mount(root, { hour: 14 });
      flush();
      near(window.scrollY, 480);
      assert.equal(root.querySelector('.reading-fold').open, true, label);
      assert.equal(reportViewOwnsScroll('report', brief.hasHourScroll()), true, label);
      assert.equal(replaced, false, label);
    }
  } finally {
    brief.stop();
  }
});

test('a partial snapshot refresh keeps the anchor and the scroll', async () => {
  const start = Date.parse('2026-10-08T06:00:00Z');
  const current = edition('edition:scrollhour003', start, ['info-one']);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const state = {
    refresh: {
      startAt: start,
      next() {
        calls += 1;
        if (calls === 1) return Promise.resolve(snapshotFor(current, { id: 'rh:partial', status: 'partial' }));
        return gate.then(() => snapshotFor(current, { id: 'rh:ready', status: 'ready' }));
      },
    },
  };
  const { root, page } = await mountHour([current], { state });
  try {
    assert.equal(root.dataset.readingSnapshot, 'rh:partial');
    flush();
    window.scrollY = 500;
    rects.set('info-one', { top: 80, bottom: 160 });
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    rects.set('info-one', { top: 200, bottom: 280 });
    flush();
    assert.equal(root.dataset.readingSnapshot, 'rh:ready');
    near(window.scrollY, 620);
  } finally {
    page.stop();
    rects.clear();
  }
});

test('going back from a later hour restores the earlier hour scroll and open item', async () => {
  const start = Date.parse('2026-10-08T06:00:00Z');
  const newer = edition('edition:scrollhour004', start, ['info-one']);
  const older = edition('edition:scrollhour005', start - HOUR, ['info-old']);
  const { root, page } = await mountHour([newer, older]);
  try {
    window.scrollY = 710;
    const fold = root.querySelector('.reading-fold');
    fold.open = true;
    await fold.listeners.toggle[0]();
    await page.selectHour(older.window.startAt);
    flush();
    window.scrollY = 40;
    await page.selectHour(newer.window.startAt);
    flush();
    near(window.scrollY, 710);
    assert.equal(root.querySelector('.reading-fold').open, true);
  } finally {
    page.stop();
  }
});
