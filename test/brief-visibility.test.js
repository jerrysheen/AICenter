import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function element(tag) {
  return {
    tag,
    className: '',
    textContent: '',
    id: '',
    type: '',
    value: '',
    hidden: false,
    open: false,
    isConnected: false,
    dataset: {},
    style: {},
    children: [],
    classList: {
      add() {},
      remove() {},
      contains() { return false; },
      toggle() {},
    },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes.flat(); },
    remove() {},
    close() {},
    focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    get childElementCount() { return this.children.length; },
  };
}

globalThis.document = {
  hidden: false,
  body: element('body'),
  activeElement: null,
  listeners: [],
  createElement: element,
  createTextNode: (text) => ({ textContent: text }),
  addEventListener(type, fn) { this.listeners.push({ type, fn }); },
  getElementById() { return null; },
  querySelector() { return null; },
};
globalThis.window = {
  scrollY: 0,
  listeners: [],
  addEventListener(type, fn) { this.listeners.push({ type, fn }); },
  scrollTo() {},
  getSelection() { return { toString() { return ''; } }; },
};
globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};

const { createBriefPage } = await import('../apps/web/public/brief-page.js');

function emit(target, type) {
  for (const entry of target.listeners) {
    if (entry.type === type) entry.fn();
  }
}

test('hiding the report keeps an in-flight read; leaving aborts it', async () => {
  const signals = [];
  const page = createBriefPage({
    api(_path, options) {
      signals.push(options.signal);
      return new Promise(() => {});
    },
    session: () => ({ role: 'desktop', device: { id: 'desk' } }),
    active: () => true,
  });
  const target = document.createElement('div');
  target.isConnected = true;
  const pending = page.mount(target);
  pending.catch(() => {});
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(signals.length >= 1);
  const signal = signals.at(-1);
  assert.equal(signal.aborted, false);
  document.hidden = true;
  emit(document, 'visibilitychange');
  assert.equal(signal.aborted, false);
  document.hidden = false;
  emit(document, 'visibilitychange');
  assert.equal(signal.aborted, false);
  page.stop();
  assert.equal(signal.aborted, true);
});

test('an aborted reading fold can be opened again', () => {
  const source = readFileSync(new URL('../apps/web/public/information-tree.js', import.meta.url), 'utf8');
  assert.match(source, /if\(aborted\(error\)\)\{loaded=false;panel\.textContent='';return;\}/);
  const brief = readFileSync(new URL('../apps/web/public/brief-page.js', import.meta.url), 'utf8');
  assert.match(brief, /if \(document\.hidden\) pause\(\)/);
  assert.match(brief, /error\?\.name === 'AbortError'/);
});
