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
  append(...nodes) { this.children.push(...nodes.flat()); }
  replaceChildren(...nodes) { this.children = nodes.flat(); }
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
