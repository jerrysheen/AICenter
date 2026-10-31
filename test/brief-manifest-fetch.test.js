import test from 'node:test';
import assert from 'node:assert/strict';

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
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
};
globalThis.window = {
  scrollY: 0,
  addEventListener() {},
  scrollTo() {},
  getSelection() { return { toString() { return ''; } }; },
};
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

const { createBriefPage } = await import('../apps/web/public/brief-page.js');

function textOf(node) {
  const parts = [];
  const walk = (item) => {
    if (!item || typeof item !== 'object') return;
    if (item.textContent) parts.push(item.textContent);
    if (item.className) parts.push(item.className);
    for (const child of item.children || []) walk(child);
  };
  walk(node);
  return parts.join('\n');
}

function pageWith(read) {
  const calls = [];
  const page = createBriefPage({
    api(path) {
      calls.push(path);
      return read(path);
    },
    session: () => ({ role: 'desktop', device: { id: 'desk' } }),
    active: () => true,
  });
  const target = document.createElement('div');
  target.isConnected = true;
  return { page, target, calls };
}

async function settle(page, target) {
  try {
    await page.mount(target);
    return null;
  } catch (error) {
    return error;
  }
}

const tree = (pipeline) => ({
  timezone: 'Asia/Shanghai',
  pipeline,
  directions: {},
  hours: [],
  days: [],
  information: [],
});

test('an empty 200 manifest is not cached and does not open the legacy brief', async () => {
  const { page, target, calls } = pageWith(async () => ({}));
  const error = await settle(page, target);
  assert.equal(error, null);
  const shown = textOf(target);
  assert.match(shown, /tree-hour-skeleton/);
  assert.match(shown, /暂时无法读取简报刊期/);
  assert.match(shown, /重试读取/);
  assert.doesNotMatch(shown, /旧版简报|三层浓缩树/);
  assert.equal(calls[0].includes('/api/v1/reports/reading-hour') && !calls[0].includes('/index'), true);
  assert.equal(calls.some((path) => path.includes('information=1')), false);
  assert.equal(calls.filter((path) => path.includes('/reports/tree')).length, 2);
  assert.equal(calls.some((path) => path.includes('/reports/hourly')), false);

  await settle(page, target);
  assert.equal(calls.filter((path) => path.includes('/reports/tree')).length, 4);
  assert.equal(calls.some((path) => path.includes('information=1')), false);
  page.stop();
});

test('a failed manifest read shows the skeleton retry instead of the legacy brief', async () => {
  const { page, target, calls } = pageWith(async () => { throw new Error('响应不完整，请稍后重试'); });
  const error = await settle(page, target);
  assert.equal(error, null);
  const shown = textOf(target);
  assert.match(shown, /tree-hour-skeleton/);
  assert.match(shown, /重试读取/);
  assert.doesNotMatch(shown, /旧版简报/);
  assert.equal(calls.some((path) => path.includes('/reports/hourly')), false);
  page.stop();
});

test('a manifest without pipeline but with v3.1 heads stays on the tree and is not cached', async () => {
  const manifest = { timezone: 'Asia/Shanghai', information: [{ validatorVersion: 'tree-response-v3.1.0' }], hours: [], days: [] };
  const { page, target, calls } = pageWith(async () => manifest);
  const error = await settle(page, target);
  assert.ok(error, 'tree mount continues past the pipeline check');
  assert.doesNotMatch(textOf(target), /旧版简报/);
  await settle(page, target);
  assert.equal(calls.filter((path) => path.includes('/reports/tree')).length, 2);
  page.stop();
});

test('only an explicit legacy pipeline opens the old brief', async () => {
  const { page, target } = pageWith(async () => tree('legacy'));
  await settle(page, target);
  const shown = textOf(target);
  assert.match(shown, /旧版简报/);
  assert.doesNotMatch(shown, /三层浓缩树/);
  page.stop();
});

test('a failed refetch keeps the last manifest that had a pipeline', async () => {
  const now = Date.now();
  let clock = now;
  const original = Date.now;
  Date.now = () => clock;
  let mode = 'ok';
  const { page, target, calls } = pageWith(async () => {
    if (mode === 'throw') throw new Error('响应不完整，请稍后重试');
    if (mode === 'empty') return {};
    return tree('tree-v3');
  });
  try {
    const first = await settle(page, target);
    assert.ok(first);
    assert.equal(calls[0].includes('/api/v1/reports/reading-hour') && !calls[0].includes('/index'), true);
    assert.equal(calls.filter((path) => path.includes('/reports/tree')).length, 1);
    assert.equal(calls.some((path) => path.includes('information=1')), false);
    assert.doesNotMatch(textOf(target), /旧版简报/);

    await settle(page, target);
    assert.equal(calls.filter((path) => path.includes('/reports/tree')).length, 1);

    clock = now + 31_000;
    mode = 'throw';
    const failed = await settle(page, target);
    assert.ok(failed);
    assert.doesNotMatch(textOf(target), /旧版简报/);
    assert.equal(calls.some((path) => path.includes('/reports/hourly')), false);
    assert.equal(calls.some((path) => path.includes('information=1')), false);

    clock = now + 62_000;
    mode = 'empty';
    const empty = await settle(page, target);
    assert.ok(empty);
    assert.doesNotMatch(textOf(target), /旧版简报/);
    assert.equal(calls.some((path) => path.includes('information=1')), false);
  } finally {
    Date.now = original;
    page.stop();
  }
});

function spanOf(path) {
  const url = new URL(path, 'http://local');
  return Number(url.searchParams.get('endAt')) - Number(url.searchParams.get('startAt'));
}

test('hourly entry requests the reading hour before a week index', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const page = createBriefPage({
    api(path) {
      calls.push(path);
      if (path.includes('/reading-hour') && !path.includes('/index')) return gate;
      return Promise.resolve(tree('tree-v3'));
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
  assert.equal(calls[0].includes('/api/v1/reports/reading-hour') && !calls[0].includes('/index'), true);
  assert.equal(calls.some((path) => path.includes('information=1')), false);
  const indexes = calls.filter((path) => path.includes('/reports/tree?'));
  assert.ok(indexes.length >= 1);
  for (const path of indexes) assert.ok(spanOf(path) <= 6 * 3600000, path);
  release({ ok: true, empty: true, snapshot: null, message: '这一小时没有内容' });
  await Promise.resolve();
  page.stop();
});

test('daily entry requests the latest card, then that editorial, before the week index', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const page = createBriefPage({
    api(path) {
      calls.push(path);
      if (path.includes('latest-daily')) return gate;
      if (path.includes('/editorial')) return new Promise(() => {});
      return Promise.resolve(tree('tree-v3'));
    },
    session: () => ({ role: 'desktop', device: { id: 'desk' } }),
    active: () => true,
  });
  const target = document.createElement('div');
  target.isConnected = true;
  const pending = page.mount(target, { mode: 'daily' });
  pending.catch(() => {});
  await Promise.resolve();
  assert.deepEqual(calls, ['/api/v1/reports/tree/latest-daily']);
  const start = 1_700_000_000_000;
  release({
    ok: true,
    daily: {
      editionId: 'edition:daily-one',
      reportDate: '2026-10-31',
      window: { startAt: start, endAt: start + 86400000 },
      hasEditorial: true,
      generatedAt: start,
    },
  });
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  assert.equal(calls[1].includes('/api/v1/reports/tree/editorial'), true);
  assert.equal(calls.some((path) => path.includes('information=1')), false);
  assert.equal(calls.some((path) => path.includes('view=index') && spanOf(path) > 2 * 86400000), false);
  page.stop();
});

test('a dated daily requests that day editorial before any week index', async () => {
  const calls = [];
  const page = createBriefPage({
    api(path) {
      calls.push(path);
      if (path.includes('/editorial')) return new Promise(() => {});
      return Promise.resolve(tree('tree-v3'));
    },
    session: () => ({ role: 'desktop', device: { id: 'desk' } }),
    active: () => true,
  });
  const target = document.createElement('div');
  target.isConnected = true;
  const pending = page.mount(target, { date: '2026-10-30' });
  pending.catch(() => {});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls[0].includes('/api/v1/reports/tree/editorial'), true);
  assert.equal(calls.some((path) => path.includes('information=1')), false);
  const indexes = calls.filter((path) => path.includes('view=index'));
  assert.ok(indexes.length >= 1);
  for (const path of indexes) assert.equal(spanOf(path), 86400000);
  page.stop();
});

test('information index path covers one edition window, not seven days', async () => {
  const { informationIndexPath } = await import('../apps/web/public/information-tree.js');
  const start = 1_700_000_000_000;
  assert.equal(
    informationIndexPath(start, start + 3600000),
    `/api/v1/reports/tree?view=index&information=1&startAt=${start}&endAt=${start + 3600000}`,
  );
  assert.equal(informationIndexPath(start, start + 86400000), `/api/v1/reports/tree?view=index&information=1&startAt=${start}&endAt=${start + 86400000}`);
  assert.equal(informationIndexPath(start, start + 7 * 86400000), '');
});
