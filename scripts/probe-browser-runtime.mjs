import { createConfiguredBrowserRuntime } from '../packages/connectors/src/browser/index.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInstanceConfig } from '../packages/instance/src/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const instance = resolveInstanceConfig({ repositoryRoot });

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const loginTimeoutMs = Math.max(3_000, Number(process.env.AI_BROWSER_PROBE_TIMEOUT_MS) || 12_000);

const BILIBILI_LOGIN = `(() => ({
  url: location.href,
  title: document.title || '',
  loggedIn: Boolean(
    document.cookie.split(';').some((part) => part.trim().startsWith('DedeUserID='))
    || document.querySelector('.header-avatar-wrap')
    || document.querySelector('.bili-avatar')
  ),
}))()`;

const X_LOGIN = `(() => {
  const bodyText = document.body ? document.body.innerText || '' : '';
  const loginWall = !!(
    document.querySelector('[data-testid="login"]')
    || document.querySelector('a[href="/login"]')
    || /Sign in to X|Log in to X|登录 X|登入 X/i.test(bodyText)
  );
  const loggedIn = !!(
    document.querySelector('[data-testid="SideNav_NewTweet_Button"]')
    || document.querySelector('[data-testid="AppTabBar_Home_Link"]')
    || document.querySelector('[aria-label="Post"]')
  );
  return { url: location.href, title: document.title || '', loggedIn: loggedIn && !loginWall, loginWall };
})()`;

async function waitForLogin(session, expression, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await session.evaluate(expression);
    const loggedIn = Boolean(last?.loggedIn);
    console.log(`[probe] ${label} url=${last?.url || ''} loggedIn=${loggedIn}`);
    if (loggedIn) return last;
    await delay(3_000);
  }
  return last;
}

const runtime = createConfiguredBrowserRuntime({ defaultBrowserId: instance.browserId });
const health = await runtime.health();
console.log('[probe] health', JSON.stringify(health));
if (!health.available) {
  console.error('[probe] 浏览器扩展未连接。请在 Chrome 打开 BrowserSkill 扩展并连上当前 daemon，然后重试。');
  process.exitCode = 1;
} else {
  const result = await runtime.withSession({ purpose: 'ai-center.login-probe', focused: true }, async (session) => {
    await session.navigate('https://www.bilibili.com');
    const bili = await waitForLogin(session, BILIBILI_LOGIN, 'bilibili', loginTimeoutMs);
    await session.navigate('https://x.com/home');
    const x = await waitForLogin(session, X_LOGIN, 'x', loginTimeoutMs);
    return { bili, x };
  });
  console.log('[probe] done', JSON.stringify({
    bilibiliLoggedIn: Boolean(result.bili?.loggedIn),
    xLoggedIn: Boolean(result.x?.loggedIn),
  }));
  if (!result.bili?.loggedIn || !result.x?.loggedIn) process.exitCode = 2;
}
