import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from '../packages/database/src/index.js';
import {
  composeFocus,
  loadXFocusConfig,
  nextNotInterestedSettings,
  rankAutoLikeCandidates,
  rankNotInterestedCandidates,
} from '../packages/domain/src/x-focus.js';
import { createXFocusService } from '../packages/domain/src/x-auto-like.js';
import { createXLikeBrowserPort, buildXNotInterestedExpression } from '../packages/connectors/src/x/like-browser.js';
import { createFeedInteractionService } from '../packages/domain/src/feed-interaction-service.js';
import { createFeedInteractionJobHandlers } from '../packages/runtime/src/feed-interaction-module.js';
import { X_NOT_INTERESTED_JOB_TYPE } from '../packages/contracts/src/feed-interaction.js';
import { createXFocusPage } from '../apps/web/public/x-focus-page.js';

const config = loadXFocusConfig(path.join(process.cwd(), 'config'));
const NOW = Date.parse('2026-10-21T04:00:00+08:00');
const TEXT = '布伦特原油供应持续趋紧，交易员正在重估油价，以及相关公司未来两个季度的订单和库存情况。';

function scores(dir, score) {
  return Object.fromEntries(config.directions.map((item) => [item.id, item.id === dir ? score : 0]));
}

function focus(dir, score, extra = {}) {
  return {
    ...composeFocus(scores(dir, score), config),
    sensitive: false,
    officialSpeech: false,
    promotional: false,
    gossip: false,
    reason: extra.reason || '测试依据',
    method: 'model',
    version: config.version,
    ...extra,
  };
}

function row(tweetId, itemFocus, extra = {}) {
  return {
    contentItemId: extra.contentItemId || randomUUID(),
    externalId: tweetId,
    tweetId,
    title: extra.title || '测试帖',
    text: extra.text === undefined ? TEXT : extra.text,
    authorHandle: extra.authorHandle || 'writer',
    authorName: extra.authorName || '',
    sourceUrl: `https://x.com/${extra.authorHandle || 'writer'}/status/${tweetId}`,
    capturedAt: extra.capturedAt || NOW,
    sourceExternalId: extra.sourceExternalId || 'home:for-you',
    feed: extra.feed,
    metadata: { filterDecision: 'KEEP', xFocus: itemFocus, ...(extra.metadata || {}) },
    focus: itemFocus,
  };
}

function serviceFor(state, calls, env) {
  return createXFocusService({
    config,
    env,
    now: () => state.now,
    feedRepository: { listModelScoredXCaptures: () => state.rows },
    authorRepository: { listFollowedHandles: () => state.followed || [] },
    runtimeRepository: {
      listJobsByType: (type) => state.jobs.filter((job) => job.type === type),
      listOpenJobs: (type) => state.open[type] || [],
    },
    snapshots: {
      readSnapshot: (_workspace, key) => (state.snapshots[key] ? { payload: state.snapshots[key] } : null),
      saveSnapshot: (_workspace, key, payload) => { state.snapshots[key] = payload; },
    },
    requestLike: (_workspace, input) => {
      calls.push(input);
      state.jobs.push({ type: 'feed.x.like', createdAt: state.now, status: 'queued', input });
    },
    requestNotInterested: (_workspace, input) => {
      calls.push(input);
      state.jobs.push({ type: X_NOT_INTERESTED_JOB_TYPE, createdAt: state.now, status: 'queued', input });
    },
  });
}

test('all-zero focus leaves the primary direction empty', () => {
  const blank = composeFocus(scores('us-market', 0), config);
  assert.equal(blank.primaryDir, '');
  assert.equal(blank.rank, 0);
  const chip = composeFocus(scores('semis', 0.4), config);
  assert.equal(chip.primaryDir, 'semis');
});

test('bamboo keeps unscored admission and uses the configured like floor', async () => {
  const kept = row('4101', focus('semis', 0.8));
  const missing = row('4101', focus('semis', 0.8));
  delete missing.metadata.filterDecision;
  const dropped = row('4102', focus('oil-geopolitics', 0.99), { metadata: { filterDecision: 'DROP' } });
  const fallback = row('4103', focus('oil-geopolitics', 0.97), { metadata: { filterDecision: 'KEEP', filterReason: 'fallback-xfocus' } });
  const low = row('4104', focus('semis', 0.79));
  const corporate = row('4105', focus('corporate', 0.89));
  const state = {
    now: NOW,
    rows: [missing, dropped, fallback, low, corporate],
    jobs: [],
    open: {},
    snapshots: {},
    followed: [],
  };
  const calls = [];
  const env = { AI_CENTER_X_AUTO_LIKE: '1', AI_CENTER_CLASSIFICATION_PROVIDER: 'bamboo' };
  const service = serviceFor(state, calls, env);
  assert.equal((await service.dispatch('local')).dispatched, false);
  service.setPageEnabled('local', true);
  const first = await service.dispatch('local');
  assert.equal(first.tweetId, '4103');
  state.rows = [missing, low, corporate];
  state.now = NOW + 15 * 60 * 1000 + 1_000;
  assert.equal((await service.dispatch('local')).tweetId, '4101');
  state.jobs = [];
  state.rows = [low, corporate];
  state.now += 15 * 60 * 1000 + 1_000;
  assert.equal((await service.dispatch('local')).reason, 'empty');
  state.rows = [row('4106', focus('corporate', 0.9))];
  state.now += 15 * 60 * 1000 + 1_000;
  assert.equal((await service.dispatch('local')).tweetId, '4106');
  const strict = rankAutoLikeCandidates([fallback, kept].map((item) => ({ ...item, tweetId: item.externalId })), [], {
    ...config,
    limits: config.autoLike,
  }, NOW);
  assert.equal(strict.eligible, 1);
  assert.equal(strict.picked.tweetId, '4101');
});

test('not interested stays off until both switches are on, then hides promos and low streaks', async () => {
  const promo = row('5101', focus('hardware', 0.2, { promotional: true, reason: '推销工具' }), { authorHandle: 'ads' });
  const gossip = row('5102', focus('us-market', 0.7, { gossip: true }), { authorHandle: 'tabloid' });
  const speech = row('5103', focus('polymarket', 0.2, { officialSpeech: true }), { authorHandle: 'minister' });
  const followed = row('5104', focus('hardware', 0.99, { promotional: true }), { authorHandle: 'Friend' });
  const following = row('5105', focus('hardware', 0.99, { promotional: true }), {
    authorHandle: 'timeline',
    sourceExternalId: 'home:following',
  });
  const one = row('5106', focus('us-market', 0.1), { authorHandle: 'quiet', capturedAt: NOW - 3_000 });
  const two = row('5107', focus('us-market', 0.1), { authorHandle: 'quiet', capturedAt: NOW - 2_000 });
  const lows = [0, 1, 2].map((index) => row(`520${index}`, focus('us-market', 0.1), {
    authorHandle: 'churn',
    capturedAt: NOW - (3 - index) * 1_000,
  }));
  const state = {
    now: NOW,
    rows: [promo, gossip, speech, followed, following, one, two],
    jobs: [],
    open: {},
    snapshots: {},
    followed: ['friend'],
  };
  const calls = [];
  const env = { AI_CENTER_X_NOT_INTERESTED: '1' };
  const service = serviceFor(state, calls, env);
  assert.equal((await service.dispatchNotInterested('local')).dispatched, false);
  assert.equal(service.view('local').notInterested.pageOn, false);
  assert.equal(service.view('local').notInterested.environmentOn, true);
  service.setNotInterestedEnabled('local', true);
  const first = await service.dispatchNotInterested('local');
  assert.equal(first.trigger, 'post');
  assert.equal(calls[0].authorHandle, 'ads');
  assert.equal(calls[0].source, 'auto');
  state.rows = state.rows.filter((item) => item.externalId !== '5101');
  state.now = NOW + 10 * 60 * 1000 + 1_000;
  assert.equal((await service.dispatchNotInterested('local')).tweetId, '5102');
  state.rows = [speech, followed, following, one, two];
  state.now += 10 * 60 * 1000 + 1_000;
  assert.equal((await service.dispatchNotInterested('local')).reason, 'empty');
  state.rows = lows;
  state.now += 10 * 60 * 1000 + 1_000;
  const streak = await service.dispatchNotInterested('local');
  assert.equal(streak.tweetId, '5202');
  assert.equal(streak.trigger, 'streak');
  state.now += 1_000;
  assert.equal((await service.dispatchNotInterested('local')).reason, 'limit');
  const stopped = nextNotInterestedSettings(
    nextNotInterestedSettings({ pageEnabled: true }, 'unconfirmed'),
    'unconfirmed',
  );
  assert.equal(stopped.pageEnabled, false);
  assert.match(stopped.notice, /连续两次/);
  assert.match(nextNotInterestedSettings({ pageEnabled: true }, 'login-required').notice, /重新登录/);
});

test('scored captures in the last day are selectable and a promo can be marked', async () => {
  const at = Date.now();
  const store = createStore(':memory:');
  try {
    const feed = store.repositories.feed;
    const account = feed.upsertSourceAccount({
      workspaceId: 'local', provider: 'x', externalId: 'x:home:for-you', displayName: '推荐',
    });
    const save = (externalId, capturedAt, itemFocus, handle) => {
      feed.saveCapture({
        workspaceId: 'local',
        provider: 'x',
        externalId,
        sourceAccountId: account.id,
        sourceUrl: `https://x.com/${handle}/status/${externalId}`,
        title: `帖子${externalId}`,
        contentHash: `hash-${externalId}`,
        capturedAt,
        authorNativeId: handle,
        metadata: {
          originalText: TEXT,
          authorHandle: handle,
          authorProfile: { handle, name: handle, nativeId: handle },
          filterDecision: itemFocus ? 'KEEP' : '',
          ...(itemFocus ? { xFocus: itemFocus } : {}),
        },
      });
      const captured = feed.getCapture('local', 'x', externalId);
      return feed.saveContentItem({
        workspaceId: 'local',
        captureId: captured.id,
        originType: 'subscription',
        contentType: 'post',
        title: `帖子${externalId}`,
        body: TEXT,
        sourceUrl: `https://x.com/${handle}/status/${externalId}`,
        authorName: handle,
      });
    };
    save('6001', at, null, 'fresh');
    save('6002', at - 1_000, { ...focus('oil-geopolitics', 0.2), method: 'keyword' }, 'word');
    save('6003', at - 2 * 60 * 60 * 1000, focus('oil-geopolitics', 0.91), 'oil');
    const promoItem = save('6004', at - 30 * 60 * 1000, focus('hardware', 0.4, { promotional: true, reason: '推销' }), 'ads');
    save('6005', at - 40 * 60 * 1000, { ...focus('semis', 0.6), method: 'cache' }, 'cache');
    const found = feed.listModelScoredXCaptures('local', { since: at - 86_400_000, limit: 5000 })
      .map((item) => item.externalId);
    assert.deepEqual(found.sort(), ['6003', '6004', '6005']);
    store.repositories.authors.setFollow('local', 'x:oil', true);
    assert.ok(store.repositories.authors.listFollowedHandles('local', 'x').some((handle) => handle.toLowerCase() === 'oil'));
    const calls = [];
    const service = createXFocusService({
      config,
      env: { AI_CENTER_X_NOT_INTERESTED: '1', AI_CENTER_X_AUTO_LIKE: '1' },
      now: () => at,
      feedRepository: feed,
      authorRepository: store.repositories.authors,
      runtimeRepository: store,
      snapshots: store.repositories.runtimeSnapshots,
      requestLike: () => { throw new Error('不该点赞'); },
      requestNotInterested: (workspaceId, input) => {
        calls.push(input);
        return store.createJob({ type: X_NOT_INTERESTED_JOB_TYPE, workspaceId, input, maxAttempts: 1 });
      },
    });
    service.setNotInterestedEnabled('local', true);
    const dispatched = await service.dispatchNotInterested('local');
    assert.equal(dispatched.tweetId, '6004');
    assert.equal(calls[0].contentItemId, promoItem.id);
    const handlers = createFeedInteractionJobHandlers(createFeedInteractionService({
      feedRepository: feed,
      runtimeRepository: store,
      likePort: { notInterested: async () => ({ status: 'done', accountHandle: 'reader', checkedAt: NOW }) },
    }), {
      onNotInterested: (workspaceId, output) => service.recordNotInterested(workspaceId, output),
    });
    const claimed = store.claimNextJob('fixture', [X_NOT_INTERESTED_JOB_TYPE]);
    const output = await handlers[X_NOT_INTERESTED_JOB_TYPE](claimed.input, { job: claimed });
    assert.equal(output.status, 'done');
    const view = service.view('local');
    assert.equal(view.notInterested.todayCount, 1);
    assert.equal(view.notInterestedActions[0].result, '已标记不感兴趣');
    assert.equal(view.notInterestedActions[0].title, '帖子6004');
    assert.equal(view.drift.notInterested.at(-1), 1);
    assert.equal(JSON.stringify(view).includes('primaryDir'), false);
    assert.equal(JSON.stringify(view).toLowerCase().includes('bamboo'), false);
  } finally {
    store.close();
  }
});

function element(tag, attrs = {}, children = []) {
  const node = {
    tag,
    attrs,
    children,
    parent: null,
    clicked: false,
    innerText: attrs.text || '',
    textContent: attrs.text || '',
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    getClientRects() { return attrs.hidden ? [] : [{}]; },
    click() { this.clicked = true; },
    matches(selector) { return matchSelector(this, selector); },
    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches?.(selector)) return current;
        current = current.parent || null;
      }
      return null;
    },
    querySelector(selector) { return queryAll(this, selector)[0] || null; },
    querySelectorAll(selector) { return queryAll(this, selector); },
  };
  for (const child of children) child.parent = node;
  return node;
}

function matchSelector(node, selector) {
  if (selector.includes(',')) return selector.split(',').some((part) => matchSelector(node, part.trim()));
  const tag = selector.split('[')[0];
  if (tag && node.tag !== tag) return false;
  for (const raw of selector.match(/\[[^\]]+\]/g) || []) {
    const body = raw.slice(1, -1);
    const star = body.match(/^([^*]+)\*=(["'])(.*)\2$/);
    const exact = body.match(/^([^=]+)=(["'])(.*)\2$/);
    if (star) {
      if (!String(node.attrs[star[1]] || '').includes(star[3])) return false;
    } else if (exact) {
      if (String(node.attrs[exact[1]] || '') !== exact[3]) return false;
    } else if (!Object.prototype.hasOwnProperty.call(node.attrs, body)) return false;
  }
  return true;
}

function queryAll(root, selector) {
  if (selector.includes(',')) {
    const found = [];
    for (const part of selector.split(',')) found.push(...queryAll(root, part.trim()));
    return [...new Set(found)];
  }
  const parts = selector.trim().split(/\s+/);
  let current = [root];
  for (const part of parts) {
    const next = [];
    for (const node of current) {
      const visit = (item) => {
        for (const child of item.children || []) {
          if (child.matches?.(part)) next.push(child);
          visit(child);
        }
      };
      visit(node);
    }
    current = next;
  }
  return current;
}

function permalinkDocument({ withMenu = false, labels = ['Mute', 'Not interested in this post', 'Block'], toast = '' } = {}) {
  const article = element('article', { 'data-testid': 'tweet' }, [
    element('a', { href: '/alice/status/555' }, [element('time')]),
    element('button', { 'data-testid': 'caret', 'aria-label': 'More' }),
    element('button', { 'data-testid': 'like' }),
  ]);
  const menu = element('div', { role: 'menu', hidden: !withMenu }, labels.map((label) => element('div', { role: 'menuitem', text: label })));
  const nodes = [
    element('a', { 'data-testid': 'AppTabBar_Profile_Link', href: '/reader' }),
    element('button', { 'data-testid': 'SideNav_AccountSwitcher_Button' }),
    article,
    menu,
  ];
  if (toast) nodes.push(element('div', { 'data-testid': 'toast', text: toast }));
  return element('document', {}, nodes);
}

function runExpression(mode, document) {
  const context = vm.createContext({
    document,
    location: { origin: 'https://x.com', pathname: '/i/web/status/555' },
    Date,
  });
  return vm.runInContext(buildXNotInterestedExpression('555', mode, mode === 'read' ? '' : 'reader'), context);
}

test('not interested clicks only that menu item on the matched post', () => {
  const closed = permalinkDocument();
  assert.equal(runExpression('read', closed).status, 'ready');
  assert.equal(closed.querySelector('button').clicked, false);
  const opened = permalinkDocument();
  assert.equal(runExpression('open', opened).status, 'opened');
  assert.equal(opened.querySelector('button[data-testid="caret"]').clicked, true);
  assert.equal(opened.querySelector('button[data-testid="like"]').clicked, false);
  const menu = permalinkDocument({ withMenu: true });
  assert.equal(runExpression('menu', menu).status, 'menu');
  assert.equal(runExpression('choose', menu).status, 'chosen');
  const items = menu.querySelectorAll('[role="menuitem"]');
  assert.deepEqual(items.map((item) => item.clicked), [false, true, false]);
  const muteOnly = permalinkDocument({ withMenu: true, labels: ['Mute', 'Block'] });
  assert.equal(runExpression('choose', muteOnly).status, 'unavailable');
  assert.equal(muteOnly.querySelectorAll('[role="menuitem"]').some((item) => item.clicked), false);
  const toast = permalinkDocument({ toast: 'Thanks. We will show you less like this.' });
  assert.equal(runExpression('confirm', toast).status, 'done');
  assert.throws(() => buildXNotInterestedExpression('nope', 'read'), /无效推文 ID/);
});

test('the not interested port confirms through the same browser session', async () => {
  const modes = [];
  const session = {
    navigate: async () => {},
    evaluate: async (expression) => {
      const mode = expression.match(/, "(read|open|menu|choose|confirm)"/)[1];
      modes.push(mode);
      if (mode === 'read') return { status: 'ready', accountHandle: 'reader', checkedAt: 1 };
      if (mode === 'open') return { status: 'opened', accountHandle: 'reader', checkedAt: 2 };
      if (mode === 'menu') return { status: 'menu', accountHandle: 'reader', checkedAt: 3 };
      if (mode === 'choose') return { status: 'chosen', accountHandle: 'reader', checkedAt: 4 };
      return { status: 'done', accountHandle: 'reader', checkedAt: 5 };
    },
  };
  const port = createXLikeBrowserPort({
    browserRuntime: { withSession: async (_options, call) => call(session) },
    delay: async () => {},
  });
  const done = await port.notInterested('555');
  assert.equal(done.status, 'done');
  assert.deepEqual(modes, ['read', 'open', 'menu', 'choose', 'confirm']);
  const missing = createXLikeBrowserPort({
    browserRuntime: {
      withSession: async (_options, call) => call({
        navigate: async () => {},
        evaluate: async (expression) => {
          const mode = expression.match(/, "(read|open|menu|choose|confirm)"/)[1];
          if (mode === 'read') return { status: 'ready', accountHandle: 'reader', checkedAt: 1 };
          if (mode === 'open') return { status: 'opened', accountHandle: 'reader', checkedAt: 2 };
          return { status: 'unavailable', accountHandle: 'reader', checkedAt: 3 };
        },
      }),
    },
    delay: async () => {},
  });
  assert.equal((await missing.notInterested('555')).status, 'unavailable');
});

test('the focus page shows daily like and not interested counts', async () => {
  class El {
    constructor(tag) {
      this.tagName = tag;
      this.className = '';
      this.children = [];
      this.checked = false;
      this.disabled = false;
    }
    set textContent(value) {
      this._text = String(value ?? '');
      this.children = [];
    }
    get textContent() {
      return `${this._text || ''}${this.children.map((child) => child.textContent || '').join('')}`;
    }
    set innerHTML(value) { this._html = String(value); }
    append(...nodes) {
      for (const node of nodes) if (node) this.children.push(node);
    }
    replaceChildren(...nodes) {
      this.children = [];
      this._text = '';
      this.append(...nodes);
    }
    addEventListener() {}
    querySelector() { return null; }
  }
  globalThis.document = {
    createElement: (tag) => new El(tag),
    createTextNode: (value) => ({ textContent: String(value) }),
  };
  const page = createXFocusPage({ api: async () => ({
    ok: true,
    autoLike: { pageOn: false, todayCount: 0, todayLimit: 8, hourCount: 0, hourLimit: 2, notice: '页面开关未打开，不会自动点赞' },
    notInterested: { pageOn: false, todayCount: 1, todayLimit: 10, hourCount: 0, hourLimit: 3, intervalMinutes: 10, notice: '页面开关未打开，不会自动标记不感兴趣' },
    drift: { dates: ['10-20', '10-21'], likes: [2, 0], notInterested: [0, 1], series: [], alerts: [] },
    actions: [],
    notInterestedActions: [{ title: '推广帖', at: NOW, handle: 'ads', triggerLabel: '单条推广或八卦', scoreText: '0.20', result: '已标记不感兴趣', reason: '推销' }],
  }), showToast() {} });
  const root = new El('div');
  await page.render(root);
  assert.match(root.textContent, /10-20/);
  assert.match(root.textContent, /2/);
  assert.match(root.textContent, /不感兴趣/);
  assert.match(root.textContent, /推广帖/);
  assert.match(root.textContent, /单条推广或八卦/);
  const inputs = [];
  const visit = (node) => {
    if (node.tagName === 'input') inputs.push(node);
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  assert.equal(inputs.length, 2);
  assert.equal(inputs.every((input) => input.checked === false), true);
});
