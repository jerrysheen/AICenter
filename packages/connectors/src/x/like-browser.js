import { LikeResultSchema } from '../../../contracts/src/feed-interaction.js';

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

export function buildXLikeExpression(postId, { click = false, expectedAccount = '' } = {}) {
  if (!/^\d{1,25}$/.test(String(postId))) throw new Error('无效推文 ID');
  return `(${inspectPost.toString()})(${JSON.stringify(String(postId))}, ${Boolean(click)}, ${JSON.stringify(expectedAccount)})`;
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
  return Object.freeze({ probe: postId => run(postId, false), like: postId => run(postId, true) });
}
