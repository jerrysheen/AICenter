import { LikeResultSchema, NotInterestedResultSchema, UnlikeResultSchema } from '../../../contracts/src/feed-interaction.js';

// This runs only in a dedicated BrowserRuntime tab. Never select a reply or a
// quoted Post by its position, and never click "unlike" on a repeated request.
function inspectPost(postId, click, expectedAccount) {
  const result = status => ({ status, accountHandle, checkedAt: Date.now() });
  let accountHandle = '';
  if (location.origin !== 'https://x.com' || !new RegExp(`/status/${postId}(?:/|$)`).test(location.pathname)) return result('blocked');
  if (document.querySelector('[data-testid="login"], a[href="/login"], a[href*="/i/flow/login"]')) return result('login-required');
  const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  const handle = profile?.getAttribute('href')?.match(/^\/([A-Za-z0-9_]{1,15})$/)?.[1];
  if (!handle || !document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')) return result('unavailable');
  accountHandle = handle;
  if (expectedAccount && accountHandle !== expectedAccount) return result('blocked');
  if ([...document.querySelectorAll('[role="dialog"]')].some(node => node.getClientRects().length)) return result('blocked');
  const primaryId = article => {
    const time = article.querySelector('a[href*="/status/"] time');
    return time?.closest('a')?.getAttribute('href')?.match(/\/status\/(\d+)(?:[/?#]|$)/)?.[1];
  };
  const candidates = [...document.querySelectorAll('article[data-testid="tweet"]')].filter(article => primaryId(article) === postId);
  if (candidates.length !== 1) return result('not-found');
  const article = candidates[0];
  const unlike = article.querySelectorAll('button[data-testid="unlike"]');
  if (unlike.length === 1) return result('already-liked');
  const buttons = article.querySelectorAll('button[data-testid="like"]');
  if (buttons.length !== 1 || buttons[0].disabled || buttons[0].getAttribute('aria-disabled') === 'true') return result('unavailable');
  if (click) buttons[0].click();
  return result('unconfirmed');
}

function inspectUnlike(postId, click, expectedAccount) {
  const result = status => ({ status, accountHandle, checkedAt: Date.now() });
  let accountHandle = '';
  if (location.origin !== 'https://x.com' || !new RegExp(`/status/${postId}(?:/|$)`).test(location.pathname)) return result('blocked');
  if (document.querySelector('[data-testid="login"], a[href="/login"], a[href*="/i/flow/login"]')) return result('login-required');
  const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  const handle = profile?.getAttribute('href')?.match(/^\/([A-Za-z0-9_]{1,15})$/)?.[1];
  if (!handle || !document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')) return result('unavailable');
  accountHandle = handle;
  if (expectedAccount && accountHandle !== expectedAccount) return result('blocked');
  if ([...document.querySelectorAll('[role="dialog"]')].some(node => node.getClientRects().length)) return result('blocked');
  const primaryId = article => {
    const time = article.querySelector('a[href*="/status/"] time');
    return time?.closest('a')?.getAttribute('href')?.match(/\/status\/(\d+)(?:[/?#]|$)/)?.[1];
  };
  const candidates = [...document.querySelectorAll('article[data-testid="tweet"]')].filter(article => primaryId(article) === postId);
  if (candidates.length !== 1) return result('not-found');
  const article = candidates[0];
  const like = article.querySelectorAll('button[data-testid="like"]');
  const unlike = article.querySelectorAll('button[data-testid="unlike"]');
  if (like.length === 1 && unlike.length === 0) return result('not-liked');
  if (unlike.length !== 1 || unlike[0].disabled || unlike[0].getAttribute('aria-disabled') === 'true') return result('unavailable');
  if (click) unlike[0].click();
  return result(click ? 'unconfirmed' : 'liked');
}

export function buildXLikeExpression(postId, { click = false, expectedAccount = '' } = {}) {
  if (!/^\d{1,25}$/.test(String(postId))) throw new Error('无效推文 ID');
  return `(${inspectPost.toString()})(${JSON.stringify(String(postId))}, ${Boolean(click)}, ${JSON.stringify(expectedAccount)})`;
}

export function buildXUnlikeExpression(postId, { click = false, expectedAccount = '' } = {}) {
  if (!/^\d{1,25}$/.test(String(postId))) throw new Error('无效推文 ID');
  return `(${inspectUnlike.toString()})(${JSON.stringify(String(postId))}, ${Boolean(click)}, ${JSON.stringify(expectedAccount)})`;
}

const NOT_INTERESTED_MODES = new Set(['read', 'open', 'menu', 'choose', 'confirm']);

function inspectNotInterested(postId, mode, expectedAccount) {
  const result = status => ({ status, accountHandle, checkedAt: Date.now() });
  let accountHandle = '';
  const labelOf = node => String(node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
  const hideItem = label => /^(not interested in this (post|tweet)|不感兴趣|对此帖文不感兴趣|对此帖子不感兴趣|对此推文不感兴趣)$/i.test(label);
  const hideToast = label => /不感兴趣|减少这类|类似内容|更少|时间线|show you less|not interested|timeline better|improve your timeline|see less/i.test(label);
  if (location.origin !== 'https://x.com' || !new RegExp(`/status/${postId}(?:/|$)`).test(location.pathname)) return result('blocked');
  if (document.querySelector('[data-testid="login"], a[href="/login"], a[href*="/i/flow/login"]')) return result('login-required');
  if (mode === 'confirm') {
    const toast = [...document.querySelectorAll('[data-testid="toast"], [role="alert"]')].map(labelOf).find(hideToast);
    return result(toast ? 'done' : 'unconfirmed');
  }
  const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  const handle = profile?.getAttribute('href')?.match(/^\/([A-Za-z0-9_]{1,15})$/)?.[1];
  if (!handle || !document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')) return result('unavailable');
  accountHandle = handle;
  if (expectedAccount && accountHandle !== expectedAccount) return result('blocked');
  const blockingDialog = [...document.querySelectorAll('[role="dialog"]')].some(node => node.getClientRects().length && !node.querySelector('[role="menu"], [role="menuitem"]'));
  if (blockingDialog) return result('blocked');
  const primaryId = article => {
    const time = article.querySelector('a[href*="/status/"] time');
    return time?.closest('a')?.getAttribute('href')?.match(/\/status\/(\d+)(?:[/?#]|$)/)?.[1];
  };
  const articles = [...document.querySelectorAll('article[data-testid="tweet"]')].filter(article => primaryId(article) === postId);
  if (articles.length !== 1) return result('not-found');
  const article = articles[0];
  const carets = [...article.querySelectorAll('button')].filter(button => {
    const testId = button.getAttribute('data-testid') || '';
    const aria = (button.getAttribute('aria-label') || '').trim();
    return testId === 'caret' || /^(more|更多)$/i.test(aria);
  });
  if (carets.length !== 1) return result('unavailable');
  const menus = [...document.querySelectorAll('[role="menu"]')].filter(node => node.getClientRects().length);
  if (mode === 'read') return result(menus.length ? 'blocked' : 'ready');
  if (mode === 'open') {
    if (menus.length) return result('blocked');
    carets[0].click();
    return result('opened');
  }
  if (menus.length !== 1) return result('unavailable');
  const matches = [...menus[0].querySelectorAll('[role="menuitem"]')].filter(item => hideItem(labelOf(item)));
  if (matches.length !== 1) return result('unavailable');
  if (mode === 'choose') {
    matches[0].click();
    return result('chosen');
  }
  return result('menu');
}

export function buildXNotInterestedExpression(postId, mode = 'read', expectedAccount = '') {
  if (!/^\d{1,25}$/.test(String(postId))) throw new Error('无效推文 ID');
  if (!NOT_INTERESTED_MODES.has(mode)) throw new Error('无效操作');
  return `(${inspectNotInterested.toString()})(${JSON.stringify(String(postId))}, ${JSON.stringify(mode)}, ${JSON.stringify(String(expectedAccount || ''))})`;
}

function publishNotInterested(state) {
  const status = ['done', 'already', 'login-required', 'blocked', 'unavailable', 'not-found', 'unconfirmed'].includes(state?.status)
    ? state.status
    : 'unavailable';
  return NotInterestedResultSchema.parse({
    status,
    accountHandle: state?.accountHandle || '',
    checkedAt: state?.checkedAt || Date.now(),
  });
}

export function createXLikeBrowserPort({ browserRuntime, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!browserRuntime?.withSession) throw new Error('X 点赞需要 BrowserRuntime');
  async function run(postId, mutate) {
    const url = `https://x.com/i/web/status/${postId}`;
    // Validate before allocating a tab, even for internally generated calls.
    buildXLikeExpression(postId);
    let attempted = false;
    try {
      return await browserRuntime.withSession({ purpose: 'x.like', focused: false }, async session => {
        const read = async () => LikeResultSchema.parse(await session.evaluate(buildXLikeExpression(postId), { timeoutMs: 10_000 }));
        const load = async () => {
          await session.navigate(url, { timeoutMs: 45_000, waitUntil: 'domcontentloaded' });
          let state;
          for (let i = 0; i < 20; i++) {
            state = await read();
            if (!['unavailable', 'not-found'].includes(state.status)) return state;
            await delay(500);
          }
          return state;
        };
        const before = await load();
        if (!mutate || before.status !== 'unconfirmed') return before;
        attempted = true;
        const clicked = LikeResultSchema.parse(await session.evaluate(buildXLikeExpression(postId, { click: true, expectedAccount: before.accountHandle }), { timeoutMs: 10_000 }));
        if (clicked.status !== 'unconfirmed') return clicked;
        for (let i = 0; i < 16; i++) {
          await delay(500);
          const state = await read();
          if (state.accountHandle !== before.accountHandle) return { status: 'unconfirmed', accountHandle: '', checkedAt: Date.now() };
          if (state.status === 'already-liked') {
            // X updates the heart optimistically. Reopen the permalink and
            // verify persisted state before reporting a successful write.
            await delay(1500);
            const verified = await load();
            return LikeResultSchema.parse({ ...verified, status: verified.status === 'already-liked' && verified.accountHandle === before.accountHandle ? 'liked' : 'unconfirmed' });
          }
          if (['login-required', 'blocked'].includes(state.status)) return state;
        }
        return { status: 'unconfirmed', accountHandle: before.accountHandle, checkedAt: Date.now() };
      });
    } catch {
      // Browser exceptions can contain command text, browser IDs or URLs.
      return { status: attempted ? 'unconfirmed' : 'unavailable', accountHandle: '', checkedAt: Date.now() };
    }
  }
  async function unlike(postId) {
    const url = `https://x.com/i/web/status/${postId}`;
    buildXUnlikeExpression(postId);
    let attempted = false;
    const publish = (state, verified = false) => {
      if (state.status === 'not-liked') return UnlikeResultSchema.parse({ ...state, status: verified ? 'unliked' : 'not-liked' });
      if (['login-required', 'blocked', 'unavailable', 'not-found', 'unconfirmed'].includes(state.status)) return UnlikeResultSchema.parse(state);
      return UnlikeResultSchema.parse({ status: 'unavailable', accountHandle: state.accountHandle || '', checkedAt: state.checkedAt || Date.now() });
    };
    try {
      return await browserRuntime.withSession({ purpose: 'x.unlike', focused: false }, async session => {
        const read = async () => await session.evaluate(buildXUnlikeExpression(postId), { timeoutMs: 10_000 });
        const load = async () => {
          await session.navigate(url, { timeoutMs: 45_000, waitUntil: 'domcontentloaded' });
          let state;
          for (let i = 0; i < 20; i++) {
            state = await read();
            if (!['unavailable', 'not-found'].includes(state.status)) return state;
            await delay(500);
          }
          return state;
        };
        const before = await load();
        if (before.status !== 'liked') return publish(before, false);
        attempted = true;
        const clicked = await session.evaluate(buildXUnlikeExpression(postId, { click: true, expectedAccount: before.accountHandle }), { timeoutMs: 10_000 });
        if (clicked.status !== 'unconfirmed') return publish(clicked, false);
        for (let i = 0; i < 16; i++) {
          await delay(500);
          const state = await read();
          if (state.accountHandle !== before.accountHandle) return publish({ status: 'unconfirmed', accountHandle: '', checkedAt: Date.now() });
          if (state.status === 'not-liked') {
            await delay(1500);
            const verified = await load();
            return publish(verified.status === 'not-liked' && verified.accountHandle === before.accountHandle
              ? verified
              : { status: 'unconfirmed', accountHandle: before.accountHandle, checkedAt: Date.now() }, true);
          }
          if (['login-required', 'blocked'].includes(state.status)) return publish(state);
        }
        return publish({ status: 'unconfirmed', accountHandle: before.accountHandle, checkedAt: Date.now() });
      });
    } catch {
      return { status: attempted ? 'unconfirmed' : 'unavailable', accountHandle: '', checkedAt: Date.now() };
    }
  }
  async function notInterested(postId) {
    const url = `https://x.com/i/web/status/${postId}`;
    buildXNotInterestedExpression(postId, 'read');
    let attempted = false;
    try {
      return await browserRuntime.withSession({ purpose: 'x.not-interested', focused: false }, async session => {
        const read = async (mode, account = '') => session.evaluate(buildXNotInterestedExpression(postId, mode, account), { timeoutMs: 10_000 });
        const load = async () => {
          await session.navigate(url, { timeoutMs: 45_000, waitUntil: 'domcontentloaded' });
          let state;
          for (let i = 0; i < 20; i++) {
            state = await read('read');
            if (!['unavailable', 'not-found'].includes(state.status)) return state;
            await delay(500);
          }
          return state;
        };
        const before = await load();
        if (before.status !== 'ready') return publishNotInterested(before);
        attempted = true;
        const account = before.accountHandle || '';
        const opened = await read('open', account);
        if (['login-required', 'blocked'].includes(opened.status)) return publishNotInterested(opened);
        let menu = opened;
        for (let i = 0; i < 10; i++) {
          await delay(300);
          menu = await read('menu', account);
          if (menu.status === 'menu') break;
          if (['login-required', 'blocked', 'not-found'].includes(menu.status)) return publishNotInterested(menu);
        }
        if (menu.status !== 'menu') return publishNotInterested({ status: 'unavailable', accountHandle: account, checkedAt: Date.now() });
        const chosen = await read('choose', account);
        if (chosen.status !== 'chosen') return publishNotInterested(chosen);
        for (let i = 0; i < 16; i++) {
          await delay(500);
          const state = await read('confirm', account);
          if (state.status === 'done') return publishNotInterested({ ...state, accountHandle: account });
          if (['login-required', 'blocked'].includes(state.status)) return publishNotInterested(state);
        }
        return publishNotInterested({ status: 'unconfirmed', accountHandle: account, checkedAt: Date.now() });
      });
    } catch {
      return publishNotInterested({ status: attempted ? 'unconfirmed' : 'unavailable', accountHandle: '', checkedAt: Date.now() });
    }
  }
  return Object.freeze({ probe: postId => run(postId, false), like: postId => run(postId, true), unlike, notInterested });
}
