const FEED_TAB_LABELS = {
  'for-you': ['For you', '为你推荐', '推薦'],
  following: ['Following', '正在关注', '正在關注', '跟隨'],
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPageInspectExpression(feed) {
  const labels = FEED_TAB_LABELS[feed] || FEED_TAB_LABELS['for-you'];
  return `(() => {
    const labels = ${JSON.stringify(labels)};
    const bodyText = document.body ? document.body.innerText || "" : "";
    const loginWall = !!(
      document.querySelector('[data-testid="login"]') ||
      document.querySelector('a[href="/login"]') ||
      document.querySelector('a[href*="/i/flow/login"]') ||
      /Sign in to X|Log in to X|登录 X|登入 X/i.test(bodyText)
    );
    const loggedIn = !!(
      document.querySelector('[data-testid="SideNav_NewTweet_Button"]') ||
      document.querySelector('[data-testid="AppTabBar_Home_Link"]') ||
      document.querySelector('[data-testid="DashButton_ProfileIcon_Link"]') ||
      document.querySelector('[aria-label="Post"]') ||
      document.querySelector('[data-testid="tweetButtonInline"]')
    );
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((tab) => ({
      text: (tab.textContent || "").trim(),
      selected: tab.getAttribute("aria-selected") === "true",
    }));
    const targetTab = [...document.querySelectorAll('[role="tab"]')].find((tab) => {
      const text = tab.textContent || "";
      return labels.some((label) => text.includes(label));
    });
    let clicked = false;
    if (targetTab && targetTab.getAttribute("aria-selected") !== "true") {
      targetTab.click();
      clicked = true;
    }
    return {
      title: document.title || "",
      url: location.href,
      login_wall: loginWall,
      logged_in: loggedIn && !loginWall,
      tabs,
      selected_tab: tabs.find((tab) => tab.selected) || null,
      clicked_tab: clicked ? (targetTab ? (targetTab.textContent || "").trim() : null) : null,
    };
  })()`;
}

export function buildClickShowMoreExpression() {
  return `(() => {
    const article = document.querySelector('article[data-testid="tweet"]');
    if (!article) return { clicked: false };
    const link = article.querySelector('[data-testid="tweet-text-show-more-link"]');
    if (!link) return { clicked: false };
    link.click();
    return { clicked: true };
  })()`;
}

export function buildTweetExtractExpression() {
  return `(() => {
    const getText = (el) => (el ? (el.innerText || el.textContent || "") : "");
    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const items = articles.map((article) => {
      try {
        const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
        const showMoreEl = article.querySelector('[data-testid="tweet-text-show-more-link"]');
        const rawText = tweetTextEl ? getText(tweetTextEl) : "";
        const showMoreControl = Boolean(showMoreEl) || [...(tweetTextEl ? tweetTextEl.querySelectorAll("a,span,button") : [])].some((el) => /^(Show more|显示更多|顯示更多)$/i.test(getText(el).trim()));
        const overflow = Boolean(tweetTextEl && tweetTextEl.scrollHeight > tweetTextEl.clientHeight + 4);
        const text = rawText.replace(/\\s+(Show more|显示更多|顯示更多)\\s*$/i, "").trim();
        const timeEl = article.querySelector("time");
        const time = timeEl ? timeEl.getAttribute("datetime") : null;
        const timeLink = timeEl ? timeEl.closest('a[href*="/status/"]') : null;
        const showMoreHref = showMoreEl ? (showMoreEl.href || showMoreEl.getAttribute("href") || "") : "";
        const statusLinks = [...article.querySelectorAll('a[href*="/status/"]')].map((link) => {
          const href = link.getAttribute("href") || link.href || "";
          return href.startsWith("http") ? href : ("https://x.com" + href);
        });
        const preferredLink = showMoreHref
          || (timeLink && (timeLink.href || timeLink.getAttribute("href")))
          || statusLinks.find((href) => /\\/status\\/\\d+\\/?([?#]|$)/.test(href) && !/\\/(analytics|photo|video|history)\\b/.test(href))
          || statusLinks[0]
          || null;
        let tweetUrl = preferredLink;
        if (tweetUrl && !tweetUrl.startsWith("http")) tweetUrl = "https://x.com" + tweetUrl;
        if (tweetUrl) tweetUrl = tweetUrl.replace(/\\/(analytics|photo|video|history)\\b.*$/, "");
        let tweetId = null;
        if (tweetUrl) {
          const match = tweetUrl.match(/\\/status\\/(\\d+)/);
          tweetId = match ? match[1] : null;
        }
        const authorEl = article.querySelector('[data-testid="User-Name"]');
        let authorHandle = null;
        let authorName = null;
        if (authorEl) {
          const handleLink = [...authorEl.querySelectorAll("a")].find((link) => /\\/[^/]+$/.test(link.getAttribute("href") || ""));
          const nameLink = authorEl.querySelector("a");
          authorName = getText(nameLink).replace(/\\s+/g, " ").trim() || null;
          if (handleLink) {
            const href = handleLink.getAttribute("href") || "";
            const handleMatch = href.match(/^\\/([^/?#]+)/);
            authorHandle = handleMatch ? handleMatch[1] : getText(handleLink).replace(/^@/, "").trim();
          }
        }
        return {
          tweet_id: tweetId,
          tweet_url: tweetUrl,
          text,
          truncated: showMoreControl || overflow,
          author_handle: authorHandle,
          author_name: authorName,
          published_at: time,
          published_timestamp: time ? Math.floor(new Date(time).getTime() / 1000) : null,
          text_source: "dom",
        };
      } catch {
        return null;
      }
    }).filter((item) => item && item.tweet_id);
    return { items };
  })()`;
}

function buildScrollExpression() {
  return `(() => {
    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const last = articles[articles.length - 1];
    if (last) last.scrollIntoView({ block: "end", inline: "nearest" });
    window.scrollBy(0, Math.max(window.innerHeight * 1.5, 900));
    return { visible_articles: articles.length, y: window.scrollY };
  })()`;
}

export function looksTruncatedTweet(tweet) {
  return Boolean(tweet?.truncated);
}

export function mergeTweets(existing, incoming, limit) {
  const byId = new Map(existing.map((item) => [item.tweet_id, item]));
  const order = existing.map((item) => item.tweet_id);
  for (const item of incoming || []) {
    if (!item?.tweet_id) continue;
    const previous = byId.get(item.tweet_id);
    if (previous) {
      const next = { ...previous, ...item };
      const previousLen = String(previous.text || '').length;
      if (String(next.text || '').length < previousLen) {
        next.text = previous.text;
      }
      const keptLen = String(next.text || '').length;
      const grewEnough = keptLen >= previousLen + 200;
      next.truncated = looksTruncatedTweet(next) || (Boolean(previous.truncated) && !grewEnough);
      byId.set(item.tweet_id, next);
      continue;
    }
    if (order.length >= limit) continue;
    byId.set(item.tweet_id, item);
    order.push(item.tweet_id);
  }
  return order.slice(0, limit).map((id) => byId.get(id));
}

const EXTRACT_TIMEOUT_MS = 45_000;

export function createXHomeBrowserClient(options = {}) {
  const runtime = options.browserRuntime;
  const wait = options.delay || delay;
  if (!runtime?.withSession) {
    throw new Error('X 浏览器访问需要 browserRuntime');
  }

  async function harvestTweets(session) {
    const extracted = await session.evaluate(buildTweetExtractExpression(), { timeoutMs: EXTRACT_TIMEOUT_MS });
    return extracted?.items || [];
  }

  async function completeTruncatedTweet(session, tweet) {
    if (!tweet?.tweet_url || !looksTruncatedTweet(tweet)) return tweet;
    await session.navigate(tweet.tweet_url, { timeoutMs: EXTRACT_TIMEOUT_MS });
    let best = tweet;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await wait(attempt === 0 ? 2_000 : 700);
      const expanded = await session.evaluate(buildClickShowMoreExpression(), { timeoutMs: EXTRACT_TIMEOUT_MS });
      if (expanded?.clicked) await wait(700);
      const extracted = await session.evaluate(buildTweetExtractExpression(), { timeoutMs: EXTRACT_TIMEOUT_MS });
      const match = (extracted?.items || []).find((item) => item.tweet_id === tweet.tweet_id)
        || extracted?.items?.[0]
        || null;
      if (match?.text && String(match.text).length > String(best.text || '').length) {
        best = { ...tweet, ...match };
      }
      const grown = String(best.text || '').length >= String(tweet.text || '').length + 200;
      if (grown && !looksTruncatedTweet({ ...best, truncated: Boolean(match?.truncated) })) break;
    }
    return { ...best, truncated: looksTruncatedTweet(best) && String(best.text || '').length < 400 };
  }

  return {
    async fetchHomeTimeline({ feed = 'for-you', limit = 50 } = {}) {
      const parsedLimit = Math.min(50, Math.max(1, Number(limit) || 50));
      return runtime.withSession({ purpose: 'x.home', focused: false }, async (session) => {
        await session.navigate('https://x.com/home');
        await wait(3_500);
        let inspect = await session.evaluate(buildPageInspectExpression(feed));
        if (inspect?.clicked_tab) {
          await wait(2_500);
          inspect = { ...inspect, ...(await session.evaluate(buildPageInspectExpression(feed))), clicked_tab: inspect.clicked_tab };
        }
        let items = [];
        const harvest = () => harvestTweets(session);
        items = mergeTweets(items, await harvest(), parsedLimit);
        let stale = 0;
        for (let round = 0; round < 8 && items.length < parsedLimit; round += 1) {
          const before = items.length;
          await session.evaluate(buildScrollExpression());
          await wait(1_800);
          items = mergeTweets(items, await harvest(), parsedLimit);
          if (items.length === before) {
            stale += 1;
            if (stale >= 2) break;
          } else {
            stale = 0;
          }
        }
        const truncated = items
          .filter((item) => looksTruncatedTweet(item))
          .sort((left, right) => String(left.text || '').length - String(right.text || '').length);
        for (const tweet of truncated) {
          const completed = await completeTruncatedTweet(session, tweet);
          items = items.map((item) => (item.tweet_id === tweet.tweet_id ? completed : item));
        }
        const loggedIn = Boolean(inspect?.logged_in);
        const loginWall = Boolean(inspect?.login_wall);
        return {
          source: 'browser_runtime_home',
          feed,
          logged_in: loggedIn,
          login_wall: loginWall,
          page_url: inspect?.url || null,
          page_title: inspect?.title || null,
          selected_tab: inspect?.selected_tab || null,
          tweet_count: items.length,
          tweets: items.slice(0, parsedLimit).map((item) => ({
            tweet_id: item.tweet_id,
            tweet_url: item.tweet_url,
            text: item.text,
            author_handle: item.author_handle,
            author_name: item.author_name,
            published_at: item.published_at,
            published_timestamp: item.published_timestamp,
            text_source: item.text_source,
          })),
          error: loggedIn ? null : loginWall ? 'login_required' : 'login_state_unclear',
        };
      });
    },
  };
}
