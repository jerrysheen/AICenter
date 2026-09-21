const FEED_TAB_LABELS = {
  'for-you': ['For you', '为你推荐', '推薦'],
  following: ['Following', '正在关注', '正在關注', '跟隨'],
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeXArticleUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const href = raw.startsWith('http') ? raw : `https://x.com${raw.startsWith('/') ? raw : `/${raw}`}`;
  const match = href.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(i\/article\/\d+|[^/?#]+\/article\/\d+)/i);
  return match ? `https://x.com/${match[1]}` : '';
}

export function findXArticleUrl(tweet) {
  const direct = normalizeXArticleUrl(tweet?.article_url || tweet?.articleUrl);
  if (direct) return direct;
  const text = String(tweet?.text || tweet?.body || '');
  const match = text.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(?:i\/article\/\d+|[^/\s?#]+\/article\/\d+)/i);
  return normalizeXArticleUrl(match ? match[0] : '');
}

export function mergeArticleIntoTweetText(tweetText, articleText) {
  const tweet = String(tweetText || '').replace(/\r\n/g, '\n').trim();
  const article = String(articleText || '').replace(/\r\n/g, '\n').trim();
  if (!article) return tweet;
  if (!tweet) return article;
  if (article.includes(tweet)) return article;
  if (tweet.includes(article)) return tweet;
  return `${tweet}\n\n${article}`;
}

const UNSCRAPED_NOTE = '[未抓取]';

function hasUnscrapedNote(text, label) {
  return String(text || '').includes(`${UNSCRAPED_NOTE} ${label}`);
}

export function appendUnscrapedMediaNotes(text, tweet = {}) {
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  const notes = [];
  if (tweet.has_video && !hasUnscrapedNote(body, '视频')) notes.push(`${UNSCRAPED_NOTE} 视频`);
  const photos = Math.max(0, Number(tweet.photo_count) || 0);
  if (photos > 0 && !hasUnscrapedNote(body, '图片')) {
    notes.push(photos === 1 ? `${UNSCRAPED_NOTE} 图片` : `${UNSCRAPED_NOTE} 图片 ×${photos}`);
  }
  const cardTitle = String(tweet.card_title || '').replace(/\s+/g, ' ').trim();
  const cardUrl = String(tweet.card_url || '').trim();
  const externalCard = Boolean(cardUrl) && !/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(cardUrl);
  if (externalCard && !hasUnscrapedNote(body, '链接卡片') && !body.includes(cardUrl)) {
    notes.push(cardTitle ? `${UNSCRAPED_NOTE} 链接卡片：${cardTitle}` : `${UNSCRAPED_NOTE} 链接卡片`);
    notes.push(cardUrl);
  }
  if (tweet.article_unfetched && !hasUnscrapedNote(body, 'X 长文')) {
    const articleUrl = findXArticleUrl(tweet) || String(tweet.tweet_url || '').trim();
    notes.push(`${UNSCRAPED_NOTE} X 长文`);
    if (articleUrl && !body.includes(articleUrl)) notes.push(articleUrl);
  }
  if (!notes.length) return body;
  return body ? `${body}\n\n${notes.join('\n')}` : notes.join('\n');
}

export function tabTextMatchesFeed(text, feed) {
  const labels = FEED_TAB_LABELS[feed] || FEED_TAB_LABELS['for-you'];
  return labels.some((label) => String(text || '').includes(label));
}

export function inspectMatchesRequestedFeed(inspect, feed) {
  const selected = inspect?.selected_tab;
  const text = typeof selected === 'string' ? selected : (selected?.text || '');
  if (!text) return null;
  return tabTextMatchesFeed(text, feed);
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
    const nodes = [
      ...document.querySelectorAll('[role="tab"]'),
      ...document.querySelectorAll('[role="tablist"] a, [role="tablist"] button'),
      ...document.querySelectorAll('[data-testid="ScrollSnap-List"] a, [data-testid="ScrollSnap-List"] button'),
    ];
    const seen = new Set();
    const tabs = [];
    for (const tab of nodes) {
      if (seen.has(tab)) continue;
      seen.add(tab);
      const text = ((tab.textContent || tab.getAttribute("aria-label") || "")).trim();
      if (!text) continue;
      tabs.push({
        text,
        selected: tab.getAttribute("aria-selected") === "true" || tab.getAttribute("aria-current") === "page",
      });
    }
    const targetTab = [...seen].find((tab) => {
      const text = (tab.textContent || tab.getAttribute("aria-label") || "");
      return labels.some((label) => text.includes(label));
    });
    let clicked = false;
    if (targetTab && targetTab.getAttribute("aria-selected") !== "true" && targetTab.getAttribute("aria-current") !== "page") {
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
      clicked_tab: clicked ? (targetTab ? ((targetTab.textContent || targetTab.getAttribute("aria-label") || "")).trim() : null) : null,
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
        const articleCover = Boolean(article.querySelector('[data-testid="article-cover-image"]'));
        const hasVideo = Boolean(article.querySelector('video, [data-testid="videoPlayer"], [data-testid="videoComponent"]'));
        const photoCount = article.querySelectorAll('[data-testid="tweetPhoto"]').length;
        const card = article.querySelector('[data-testid="card.wrapper"]');
        let cardUrl = null;
        let cardTitle = null;
        if (card) {
          const cardHrefs = [...card.querySelectorAll("a")].map((link) => {
            const href = link.getAttribute("href") || link.href || "";
            return href.startsWith("http") ? href : ("https://x.com" + href);
          }).filter(Boolean);
          cardUrl = cardHrefs.find((href) => !/https?:\\/\\/(?:www\\.)?(?:x|twitter)\\.com\\//i.test(href)) || null;
          cardTitle = getText(card).replace(/\\s+/g, " ").trim().slice(0, 80) || null;
        }
        const articleLinks = [...article.querySelectorAll('a[href*="/article/"]')].map((link) => {
          const href = link.getAttribute("href") || link.href || "";
          return href.startsWith("http") ? href : ("https://x.com" + href);
        }).filter((href) => /\\/(?:i\\/article\\/\\d+|[^/]+\\/article\\/\\d+)/.test(href));
        const textArticle = (text.match(/https?:\\/\\/(?:www\\.)?(?:x|twitter)\\.com\\/(?:i\\/article\\/\\d+|[^/\\s?#]+\\/article\\/\\d+)/i) || [])[0] || "";
        const articleUrl = articleLinks.find((href) => !/\\/media\\//.test(href)) || articleLinks[0] || textArticle || (articleCover ? tweetUrl : null);
        if (!tweetId) {
          const fromArticle = String(articleUrl || "").match(/\\/(?:status|article)\\/(\\d+)/);
          tweetId = fromArticle ? fromArticle[1] : null;
          if (tweetId && !tweetUrl) tweetUrl = "https://x.com/i/status/" + tweetId;
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
          article_url: articleUrl,
          article_cover: articleCover,
          has_video: hasVideo,
          photo_count: photoCount,
          card_url: cardUrl,
          card_title: cardTitle,
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

export function looksLikeArticleTweet(tweet) {
  return Boolean(findXArticleUrl(tweet) || tweet?.article_cover);
}

export function buildArticleExtractExpression() {
  return `(() => {
    /* x-article-body */
    const text = (el) => (el ? (el.innerText || el.textContent || "") : "");
    const bodyText = document.body ? document.body.innerText || "" : "";
    const loginWall = !!(
      document.querySelector('[data-testid="login"]') ||
      document.querySelector('a[href*="/i/flow/login"]') ||
      /We're unable to show this content|Article Not Found|Sign in to X|登录 X/i.test(bodyText)
    );
    const titleEl = document.querySelector('[data-testid="twitter-article-title"]');
    const bodyEl = document.querySelector('[data-testid="twitterArticleRichTextView"]')
      || document.querySelector('[data-testid="longformRichTextComponent"]')
      || document.querySelector('[data-testid="twitterArticleReadView"]');
    return {
      url: location.href,
      title: text(titleEl).replace(/\\s+/g, " ").trim(),
      login_wall: loginWall,
      body: text(bodyEl).replace(/\\r\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim()
    };
  })()`;
}

export function mergeTweets(existing, incoming, limit, options = {}) {
  const exclude = new Set((options.excludeExternalIds || []).map((id) => String(id || '')).filter(Boolean));
  const byId = new Map(existing.map((item) => [item.tweet_id, item]));
  const order = existing.map((item) => item.tweet_id);
  for (const item of incoming || []) {
    if (!item?.tweet_id) continue;
    if (exclude.has(String(item.tweet_id))) continue;
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
      next.article_cover = Boolean(previous.article_cover || next.article_cover);
      next.has_video = Boolean(previous.has_video || next.has_video);
      next.photo_count = Math.max(Number(previous.photo_count) || 0, Number(next.photo_count) || 0);
      next.article_url = next.article_url || previous.article_url || null;
      next.card_url = next.card_url || previous.card_url || null;
      next.card_title = next.card_title || previous.card_title || null;
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

  async function completeArticleTweet(session, tweet) {
    const articleUrl = findXArticleUrl(tweet);
    const target = articleUrl || (tweet.article_cover ? tweet.tweet_url : '');
    if (!target) return { ...tweet, article_unfetched: Boolean(tweet.article_cover) };
    await session.navigate(target, { timeoutMs: EXTRACT_TIMEOUT_MS });
    let best = { title: '', body: '' };
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await wait(attempt === 0 ? 3_000 : 1_000);
      const extracted = await session.evaluate(buildArticleExtractExpression(), { timeoutMs: EXTRACT_TIMEOUT_MS });
      if (extracted?.login_wall) break;
      const title = String(extracted?.title || '').trim();
      const body = String(extracted?.body || '').trim();
      if (body.length > String(best.body || '').length) best = { title, body };
      else if (!best.title && title) best = { ...best, title };
      if (String(best.body || '').length >= 400) break;
    }
    const articleText = [best.title, best.body].filter(Boolean).join('\n\n');
    if (!articleText) return { ...tweet, article_unfetched: true };
    const merged = mergeArticleIntoTweetText(tweet.text, articleText);
    return {
      ...tweet,
      text: merged,
      article_url: undefined,
      article_cover: false,
      article_unfetched: false,
    };
  }

  return {
    async fetchHomeTimeline({ feed = 'for-you', limit = 50, excludeExternalIds = [] } = {}) {
      const parsedLimit = Math.min(50, Math.max(1, Number(limit) || 50));
      const exclude = [...new Set((excludeExternalIds || []).map((id) => String(id || '')).filter(Boolean))];
      return runtime.withSession({ purpose: 'x.home', focused: false }, async (session) => {
        await session.navigate('https://x.com/home');
        await wait(3_500);
        const inspectHome = async () => {
          let inspect = await session.evaluate(buildPageInspectExpression(feed));
          if (inspect?.clicked_tab) {
            await wait(2_500);
            inspect = { ...inspect, ...(await session.evaluate(buildPageInspectExpression(feed))), clicked_tab: inspect.clicked_tab };
          }
          return inspect;
        };
        let inspect = await inspectHome();
        if (inspectMatchesRequestedFeed(inspect, feed) === false) {
          inspect = await inspectHome();
        }
        if (inspectMatchesRequestedFeed(inspect, feed) === false) {
          return {
            source: 'browser_runtime_home',
            feed,
            logged_in: Boolean(inspect?.logged_in),
            login_wall: Boolean(inspect?.login_wall),
            page_url: inspect?.url || null,
            page_title: inspect?.title || null,
            selected_tab: inspect?.selected_tab || null,
            tweet_count: 0,
            tweets: [],
            error: 'feed_tab_mismatch',
          };
        }
        let items = [];
        const harvest = () => harvestTweets(session);
        const merge = (current, incoming) => mergeTweets(current, incoming, parsedLimit, { excludeExternalIds: exclude });
        items = merge(items, await harvest());
        let stale = 0;
        const maxRounds = exclude.length ? 20 : 8;
        for (let round = 0; round < maxRounds && items.length < parsedLimit; round += 1) {
          const before = items.length;
          await session.evaluate(buildScrollExpression());
          await wait(1_800);
          items = merge(items, await harvest());
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
        const withArticles = items.filter((item) => looksLikeArticleTweet(item)).slice(0, 12);
        for (const tweet of withArticles) {
          const completed = await completeArticleTweet(session, tweet);
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
            text: appendUnscrapedMediaNotes(item.text, {
              ...item,
              article_unfetched: Boolean(item.article_unfetched || item.article_cover),
            }),
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
