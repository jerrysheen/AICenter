import { LikeResultSchema, UnlikeResultSchema } from '../../../contracts/src/feed-interaction.js';

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
  return Object.freeze({ probe: postId => run(postId, false), like: postId => run(postId, true), unlike });
}
