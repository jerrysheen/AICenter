import { FeedCaptureContextSchema } from '../../../contracts/src/feed-value.js';
import { xVideoFromExtract } from './video-media.js';

export function buildXCaptureContext(tweet) {
  const rootId=String(tweet.tweet_id || tweet.tweetId || '');
  const continuations=(tweet.comments || []).filter(p=>p.id && (p.authorHandle || p.authorId))
    .map(p=>({id:String(p.id),author:{handle:String(p.authorHandle || ''),accountId:String(p.authorId || '')},replyToId:String(p.replyToId || ''),
      relationVerified:p.relationVerified===true,text:String(p.text || ''),truncated:p.truncated===true}));
  return FeedCaptureContextSchema.parse({rootId,author:{handle:String(tweet.author_handle || tweet.authorHandle || ''),accountId:String(tweet.author_id || tweet.authorId || '')},
    references:(tweet.references || []).map(p=>({id:String(p.id || ''),referencedById:String(p.referencedById || ''),
      relationVerified:p.relationVerified===true,necessary:p.necessary===true,text:String(p.text || ''),truncated:p.truncated===true})),
    continuations,truncated:tweet.truncated===true,threadIncomplete:tweet.thread_incomplete===true,
    missingParts:tweet.article_unfetched || tweet.article_cover
      ? [{kind:'article',critical:true,status:'confirmed',evidence:'collector-article-unexpanded'}] : []});
}

const FEED_TAB_LABELS = {
  'for-you': ['For you', '为你推荐', '推薦'],
  following: ['Following', '正在关注', '正在關注', '跟隨'],
};

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

export const COMMENT_PREVIEW_LIMIT = 5;
const COMMENT_TEXT_MAX = 240;
const COMMENT_BLOCK_MARKER = '\n\n评论\n';

export function textBeforeCommentBlock(value) {
  const body = String(value || '').replace(/\r\n/g, '\n').trim();
  const index = body.indexOf(COMMENT_BLOCK_MARKER);
  return index === -1 ? body : body.slice(0, index).trim();
}

export function appendCommentsToBody(text, comments, limit = COMMENT_PREVIEW_LIMIT) {
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  const parsedLimit = Math.min(COMMENT_PREVIEW_LIMIT, Math.max(1, Number(limit) || COMMENT_PREVIEW_LIMIT));
  const lines = [];
  for (const comment of comments || []) {
    const author = String(comment?.author || comment?.author_name || '').replace(/\s+/g, ' ').trim();
    let content = String(comment?.text || '').replace(/\s+/g, ' ').trim();
    if (!content) continue;
    if (content.length > COMMENT_TEXT_MAX) content = `${content.slice(0, COMMENT_TEXT_MAX)}…`;
    lines.push(author ? `· ${author}：${content}` : `· ${content}`);
    if (lines.length >= parsedLimit) break;
  }
  if (!lines.length) return body;
  const block = `评论\n${lines.join('\n')}`;
  if (body.includes(block)) return body;
  return body ? `${body}${COMMENT_BLOCK_MARKER}${lines.join('\n')}` : block;
}

function comparableText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/(?:\.{3,}|…+)\s*$/u, '')
    .trim();
}

function textCoversLead(full, lead) {
  const body = comparableText(full);
  const head = comparableText(lead);
  if (!body || head.length < 12) return false;
  if (body.startsWith(head)) return true;
  const compactBody = body.replace(/\s+/g, '');
  const compactHead = head.replace(/\s+/g, '');
  return compactHead.length >= 12 && compactBody.startsWith(compactHead);
}

export function stripLeadingPreview(value) {
  let text = String(value || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return '';
  for (let pass = 0; pass < 3; pass += 1) {
    const parts = text.split(/\n\n/);
    if (parts.length >= 2 && textCoversLead(parts.slice(1).join('\n\n'), parts[0])) {
      text = parts.slice(1).join('\n\n').trim();
      continue;
    }
    const inline = text.match(/^([\s\S]{12,}?)(?:\.{3,}|…+)\s*([\s\S]+)$/u);
    if (inline && textCoversLead(inline[2], inline[1])) {
      text = inline[2].trim();
      continue;
    }
    break;
  }
  return text;
}

export function joinArticleTitle(title, body) {
  const heading = String(title || '').replace(/\s+/g, ' ').trim();
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  if (!text) return heading;
  if (!heading || textCoversLead(text, heading) || text.startsWith(heading)) return text;
  return `${heading}\n\n${text}`;
}

export function articleBodyLooksComplete(value, stable = 0) {
  const text = String(value || '').trim();
  if (!text || stable < 1) return false;
  const tail = text.split('\n').map((line) => line.trim()).filter(Boolean).pop() || '';
  if (/^https?:\/\//i.test(tail)) return true;
  if (/[。！？.!?…](?:["”’」』）\]]+)?$/u.test(tail)) return true;
  return stable >= 2;
}

export function mergeArticleIntoTweetText(tweetText, articleText) {
  const tweet = stripLeadingPreview(tweetText);
  const article = stripLeadingPreview(articleText);
  if (!article) return tweet;
  if (!tweet) return article;
  if (article.includes(tweet) || textCoversLead(article, tweet)) return article;
  if (tweet.includes(article) || textCoversLead(tweet, article)) return tweet;
  return stripLeadingPreview(`${tweet}\n\n${article}`);
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
    const getText = (el) => (el ? (el.innerText || el.textContent || "") : "");
    const inThisArticle = (el) => el && el.closest('article[data-testid="tweet"]') === article;
    const label = /^(Show more|显示更多|顯示更多)$/i;
    const candidates = [...article.querySelectorAll('[data-testid="tweet-text-show-more-link"],a,span,button')]
      .filter(inThisArticle);
    const link = candidates.find((el) => el.getAttribute("data-testid") === "tweet-text-show-more-link")
      || candidates.find((el) => label.test(getText(el).trim()));
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
        const inThisArticle = (el) => el && el.closest('article[data-testid="tweet"]') === article;
        const showMoreEl = [...article.querySelectorAll('[data-testid="tweet-text-show-more-link"]')].find(inThisArticle);
        const rawText = tweetTextEl ? getText(tweetTextEl) : "";
        const showMoreControl = Boolean(showMoreEl) || [...article.querySelectorAll("a,span,button")].some((el) => inThisArticle(el) && /^(Show more|显示更多|顯示更多)$/i.test(getText(el).trim()));
        const overflow = Boolean(tweetTextEl && tweetTextEl.clientHeight > 0 && tweetTextEl.scrollHeight > tweetTextEl.clientHeight + 4);
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
        const quoteEl = article.querySelector('[data-testid="quoteTweet"]');
        const videoNodes = [...article.querySelectorAll('video, [data-testid="videoPlayer"], [data-testid="videoComponent"]')];
        const ownHasVideo = videoNodes.some((node) => !quoteEl || !quoteEl.contains(node));
        const quoteHasVideo = Boolean(quoteEl && videoNodes.some((node) => quoteEl.contains(node)));
        let quoteTweetId = null;
        if (quoteEl) {
          const quoteHref = [...quoteEl.querySelectorAll('a[href*="/status/"]')].map((link) => {
            const href = link.getAttribute("href") || link.href || "";
            return href.startsWith("http") ? href : ("https://x.com" + href);
          }).find((href) => /\\/status\\/\\d+/.test(href)) || "";
          const quoteMatch = String(quoteHref).match(/\\/status\\/(\\d+)/);
          quoteTweetId = quoteMatch ? quoteMatch[1] : null;
        }
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
        let authorRestId = null;
        let authorAvatar = null;
        let reposterHandle = null;
        let reposterName = null;
        let reposterRestId = null;
        let reposterAvatar = null;
        try {
          let node = article;
          for (let step = 0; step < 8 && node && !authorRestId; step += 1) {
            const fiberKey = Object.keys(node).find((key) => key.indexOf("__reactFiber") === 0 || key.indexOf("__reactInternalInstance") === 0);
            let fiber = fiberKey ? node[fiberKey] : null;
            let hops = 0;
            while (fiber && hops < 8 && !authorRestId) {
              const props = fiber.memoizedProps || fiber.pendingProps || null;
              const screen = props && (props.screen_name || props.screenName || (props.legacy && props.legacy.screen_name) || (props.user && (props.user.screen_name || props.user.screenName)) || "");
              const candidate = props && (props.rest_id || props.restId || (props.user && (props.user.rest_id || props.user.id_str)) || "");
              if (authorHandle && String(screen || "").replace(/^@/, "").toLowerCase() === String(authorHandle).replace(/^@/, "").toLowerCase() && /^\\d{4,}$/.test(String(candidate || ""))) {
                authorRestId = String(candidate);
              }
              fiber = fiber.return;
              hops += 1;
            }
            node = node.parentElement;
          }
          const avatarImg = [...article.querySelectorAll("img")].find((img) => /profile_images/.test(img.src || "") && !img.closest('[data-testid="tweetPhoto"]'));
          authorAvatar = avatarImg ? (avatarImg.src || "") : null;
          const context = article.querySelector('[data-testid="socialContext"]');
          const contextText = getText(context);
          if (context && /(repost|reposted|转帖|转发|已转帖)/i.test(contextText) && !/like/i.test(contextText)) {
            const link = context.querySelector("a");
            const href = link ? (link.getAttribute("href") || "") : "";
            const handleMatch = href.match(/^\\/([^/?#]+)/);
            reposterHandle = handleMatch ? handleMatch[1] : null;
            reposterName = link ? getText(link).replace(/\\s+/g, " ").trim() : null;
            const userHref = href.match(/\\/i\\/user\\/(\\d+)/);
            reposterRestId = userHref ? userHref[1] : null;
            const avatar = link ? link.querySelector("img") : null;
            reposterAvatar = avatar ? (avatar.src || "") : null;
          }
        } catch (authorError) {
          authorRestId = authorRestId || null;
        }
        const replyEl = article.querySelector('[data-testid="reply"]');
        let replyCount = null;
        if (replyEl) {
          const label = ((replyEl.getAttribute("aria-label") || "") + " " + getText(replyEl)).replace(/,/g, "");
          const match = label.match(/(\\d+)/);
          replyCount = match ? Number(match[1]) : 0;
        }
        return {
          tweet_id: tweetId,
          tweet_url: tweetUrl,
          text,
          article_url: articleUrl,
          article_cover: articleCover,
          has_video: hasVideo,
          own_has_video: ownHasVideo,
          quote_has_video: quoteHasVideo,
          quote_tweet_id: quoteTweetId,
          photo_count: photoCount,
          card_url: cardUrl,
          card_title: cardTitle,
          show_more: showMoreControl,
          truncated: showMoreControl || overflow,
          author_handle: authorHandle,
          author_name: authorName,
          author_rest_id: authorRestId,
          author_avatar: authorAvatar,
          reposter_handle: reposterHandle,
          reposter_name: reposterName,
          reposter_rest_id: reposterRestId,
          reposter_avatar: reposterAvatar,
          reply_count: replyCount,
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

export function acceptTweetRestId(screenName, authorHandle, restId) {
  const id = String(restId || '').trim();
  const screen = String(screenName || '').replace(/^@/, '').trim();
  const handle = String(authorHandle || '').replace(/^@/, '').trim();
  if (!screen || !handle || screen.toLowerCase() !== handle.toLowerCase()) return '';
  if (!/^\d{4,}$/.test(id)) return '';
  return id;
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

export function buildStatusCommentsExpression(tweetId, limit = COMMENT_PREVIEW_LIMIT) {
  const id = String(tweetId || '').replace(/\D/g, '');
  const parsedLimit = Math.min(COMMENT_PREVIEW_LIMIT, Math.max(1, Number(limit) || COMMENT_PREVIEW_LIMIT));
  return `(() => {
    /* x-status-comments */
    const mainId = ${JSON.stringify(id)};
    const limit = ${parsedLimit};
    const getText = (el) => (el ? (el.innerText || el.textContent || "") : "");
    const statusIdOf = (article) => {
      const timeEl = article.querySelector("time");
      const timeLink = timeEl ? timeEl.closest('a[href*="/status/"]') : null;
      const href = timeLink ? (timeLink.getAttribute("href") || timeLink.href || "") : "";
      const match = String(href).match(/\\/status\\/(\\d+)/);
      return match ? match[1] : "";
    };
    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')]
      .filter((article) => !article.parentElement || !article.parentElement.closest('article[data-testid="tweet"]'));
    const mainIndex = articles.findIndex((article) => statusIdOf(article) === mainId);
    if (mainIndex < 0) return { comments: [] };
    const comments = [];
    for (const article of articles.slice(mainIndex + 1)) {
      if (article.querySelector('[data-testid="placementTracking"]')) continue;
      const text = getText(article.querySelector('[data-testid="tweetText"]')).replace(/\\s+/g, " ").trim();
      if (!text) continue;
      const nameEl = article.querySelector('[data-testid="User-Name"] a');
      const author = getText(nameEl).replace(/\\s+/g, " ").trim();
      const statusId=statusIdOf(article);
      const handleLink=[...article.querySelectorAll('[data-testid="User-Name"] a')]
        .find(link=>/^\\/[^/?#]+$/.test(link.getAttribute('href') || ''));
      const authorHandle=handleLink ? (handleLink.getAttribute('href') || '').slice(1) : '';
      // DOM order on a status page does not prove the reply parent; retain identity, never assert a relation.
      comments.push({ author, text, id:statusId, authorHandle, replyToId:'', relationVerified:false,
        truncated:Boolean(article.querySelector('[data-testid="tweet-text-show-more-link"]')) });
      if (comments.length >= limit) break;
    }
    return { comments };
  })()`;
}

export function buildArticleScrollExpression() {
  return `(() => {
    const el = document.querySelector('[data-testid="twitterArticleRichTextView"]')
      || document.querySelector('[data-testid="longformRichTextComponent"]')
      || document.querySelector('[data-testid="twitterArticleReadView"]')
      || document.scrollingElement;
    if (el && el !== document.scrollingElement) el.scrollTop = el.scrollHeight;
    window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
    return true;
  })()`;
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
      const replyCounts = [previous.reply_count, item.reply_count]
        .map((value) => (value === null || value === undefined || value === '' ? null : Number(value)))
        .filter((value) => Number.isFinite(value));
      if (replyCounts.length) next.reply_count = Math.max(...replyCounts);
      next.comments = (Array.isArray(item.comments) && item.comments.length) ? item.comments : previous.comments;
      next.comments_checked = Boolean(previous.comments_checked || item.comments_checked);
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
const FOLLOWING_EXPAND_CAP = 16;
const FOR_YOU_TRUNCATED_CAP = 8;
const EXPAND_TIME_RESERVE_MS = 45_000;

function stepOptions(timeoutMs, budget) {
  return { timeoutMs, ...(budget?.signal ? { signal: budget.signal } : {}) };
}

function abortedError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

export function rankTruncatedExpansions(items) {
  return [...items].sort((left, right) => {
    const leftScore = Number(left.x_focus?.focusScore);
    const rightScore = Number(right.x_focus?.focusScore);
    const scoreDelta = (Number.isFinite(rightScore) ? rightScore : -1) - (Number.isFinite(leftScore) ? leftScore : -1);
    if (scoreDelta !== 0) return scoreDelta;
    const lengthDelta = String(right.text || '').length - String(left.text || '').length;
    if (lengthDelta) return lengthDelta;
    return String(left.tweet_id).localeCompare(String(right.tweet_id));
  });
}

function captureStopped(signal, deadlineAt) {
  return Boolean(signal?.aborted) || (Number.isFinite(Number(deadlineAt)) && Date.now() >= Number(deadlineAt));
}

function commandTimeout(fallback, deadlineAt) {
  const limit = Math.max(1_000, Number(fallback) || EXTRACT_TIMEOUT_MS);
  if (!Number.isFinite(Number(deadlineAt))) return limit;
  const remaining = Number(deadlineAt) - Date.now();
  if (remaining < 1_000) return 0;
  return Math.min(limit, remaining);
}

export function fallbackFocusExpansions(items, keywords = [], limit = 8) {
  const words = [...new Set((keywords || []).map((word) => String(word || '').trim().toLowerCase()).filter(Boolean))];
  const cap = Math.max(1, Math.min(8, Number(limit) || 8));
  const hits = words.length
    ? items.filter((item) => words.some((word) => String(item.text || '').toLowerCase().includes(word)))
    : [];
  const chosen = hits.length
    ? hits.slice(0, cap)
    : [...items].sort((left, right) => String(right.text || '').length - String(left.text || '').length).slice(0, 3);
  return {
    mode: 'selected',
    items,
    expandIds: new Set(chosen.map((item) => item.tweet_id)),
  };
}

export function formatXExpandLog({ feed, truncated, attempted, ok, failed, reasons } = {}) {
  const reasonText = Object.entries(reasons || {})
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}:${count}`)
    .join(',') || '-';
  return `[x-home] expand feed=${feed} truncated=${truncated} attempted=${attempted} ok=${ok} failed=${failed} reasons=${reasonText}`;
}

export function selectFocusExpansions(items, scored) {
  if (!scored) return { mode: 'all', items };
  const byId = scored.byId || {};
  const minScore = Number(scored.minScore);
  const maxExpand = Math.max(1, Math.min(8, Number(scored.maxExpand) || 8));
  const next = items.map((item) => {
    const focus = byId[item.tweet_id];
    return focus ? { ...item, x_focus: focus } : item;
  });
  const ranked = next
    .filter((item) => Number(item.x_focus?.focusScore) >= minScore)
    .sort((left, right) => Number(right.x_focus.focusScore) - Number(left.x_focus.focusScore)
      || Number(right.x_focus.rank || 0) - Number(left.x_focus.rank || 0)
      || String(left.tweet_id).localeCompare(String(right.tweet_id)));
  return {
    mode: 'selected',
    items: next,
    expandIds: new Set(ranked.slice(0, maxExpand).map((item) => item.tweet_id)),
  };
}

export function createXHomeBrowserClient(options = {}) {
  const runtime = options.browserRuntime;
  const wait = options.delay || delay;
  if (!runtime?.withSession) {
    throw new Error('X 浏览器访问需要 browserRuntime');
  }

  async function harvestTweets(session, budget) {
    const timeoutMs = commandTimeout(EXTRACT_TIMEOUT_MS, budget?.deadlineAt);
    if (!timeoutMs || captureStopped(budget?.signal, budget?.deadlineAt)) return [];
    const extracted = await session.evaluate(buildTweetExtractExpression(), stepOptions(timeoutMs, budget));
    return extracted?.items || [];
  }

  async function readStatusComments(session, tweetId, budget) {
    if (!tweetId) return [];
    const timeoutMs = commandTimeout(EXTRACT_TIMEOUT_MS, budget?.deadlineAt);
    if (!timeoutMs || captureStopped(budget?.signal, budget?.deadlineAt)) return [];
    try {
      const extracted = await session.evaluate(buildStatusCommentsExpression(tweetId), stepOptions(timeoutMs, budget));
      return Array.isArray(extracted?.comments) ? extracted.comments : [];
    } catch (error) {
      if (abortedError(error)) throw error;
      return [];
    }
  }

  async function completeTruncatedTweet(session, tweet, budget) {
    if (!tweet?.tweet_url || !looksTruncatedTweet(tweet)) return tweet;
    if (captureStopped(budget?.signal, budget?.deadlineAt)) return tweet;
    const navigateTimeout = commandTimeout(EXTRACT_TIMEOUT_MS, budget?.deadlineAt);
    if (!navigateTimeout) return tweet;
    await session.navigate(tweet.tweet_url, stepOptions(navigateTimeout, budget));
    let best = tweet;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (captureStopped(budget?.signal, budget?.deadlineAt)) break;
      const stepTimeout = commandTimeout(EXTRACT_TIMEOUT_MS, budget?.deadlineAt);
      if (!stepTimeout) break;
      await wait(attempt === 0 ? 2_000 : 700, budget?.signal);
      const expanded = await session.evaluate(buildClickShowMoreExpression(), stepOptions(stepTimeout, budget));
      if (expanded?.clicked) await wait(700, budget?.signal);
      const extracted = await session.evaluate(buildTweetExtractExpression(), stepOptions(stepTimeout, budget));
      const match = (extracted?.items || []).find((item) => item.tweet_id === tweet.tweet_id)
        || extracted?.items?.[0]
        || null;
      if (match?.text && String(match.text).length > String(best.text || '').length) {
        best = { ...tweet, ...match };
      }
      if (match && match.show_more === false) {
        best = {
          ...tweet,
          ...match,
          text: String(match.text || '').length >= String(best.text || '').length ? match.text : best.text,
          truncated: false,
          show_more: false,
        };
        break;
      }
      const grown = String(best.text || '').length >= String(tweet.text || '').length + 200;
      if (grown && !looksTruncatedTweet({ ...best, truncated: Boolean(match?.truncated) })) break;
    }
    const comments = await readStatusComments(session, best.tweet_id || tweet.tweet_id, budget);
    return {
      ...best,
      truncated: looksTruncatedTweet(best),
      comments,
      comments_checked: true,
    };
  }

  async function completeArticleTweet(session, tweet, budget) {
    const articleUrl = findXArticleUrl(tweet);
    const target = articleUrl || (tweet.article_cover ? tweet.tweet_url : '');
    if (!target) return { ...tweet, article_unfetched: Boolean(tweet.article_cover) };
    if (captureStopped(budget?.signal, budget?.deadlineAt)) return { ...tweet, article_unfetched: Boolean(tweet.article_cover) };
    const navigateTimeout = commandTimeout(EXTRACT_TIMEOUT_MS, budget?.deadlineAt);
    if (!navigateTimeout) return { ...tweet, article_unfetched: Boolean(tweet.article_cover) };
    await session.navigate(target, stepOptions(navigateTimeout, budget));
    let best = { title: '', body: '' };
    let stable = 0;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (captureStopped(budget?.signal, budget?.deadlineAt)) break;
      const stepTimeout = commandTimeout(EXTRACT_TIMEOUT_MS, budget?.deadlineAt);
      if (!stepTimeout) break;
      await wait(attempt === 0 ? 3_000 : 1_000, budget?.signal);
      if (attempt > 0) {
        try { await session.evaluate(buildArticleScrollExpression(), stepOptions(stepTimeout, budget)); }
        catch (error) {
          if (abortedError(error)) throw error;
          /* the next extract still uses whatever is on the page */
        }
      }
      const extracted = await session.evaluate(buildArticleExtractExpression(), stepOptions(stepTimeout, budget));
      if (extracted?.login_wall) break;
      const title = String(extracted?.title || '').trim();
      const body = String(extracted?.body || '').trim();
      if (body.length > String(best.body || '').length) {
        best = { title, body };
        stable = 0;
      } else if (best.body) {
        stable += 1;
        if (!best.title && title) best = { ...best, title };
      } else if (title) {
        best = { ...best, title };
      }
      if (articleBodyLooksComplete(joinArticleTitle(best.title, best.body), stable)) break;
    }
    const articleText = joinArticleTitle(best.title, best.body);
    if (!articleText) return { ...tweet, article_unfetched: true };
    const complete = articleBodyLooksComplete(articleText, Math.max(stable, 1));
    const merged = mergeArticleIntoTweetText(tweet.text, articleText);
    const next = {
      ...tweet,
      text: merged,
      article_url: complete ? undefined : (articleUrl || tweet.article_url),
      article_cover: !complete,
      article_unfetched: !complete,
    };
    if (!articleUrl) {
      next.comments = await readStatusComments(session, tweet.tweet_id, budget);
      next.comments_checked = true;
    }
    return next;
  }

  async function attachStatusComments(session, tweet, budget) {
    if (tweet?.comments_checked) return tweet;
    const replies = Number(tweet?.reply_count);
    if (!tweet?.tweet_url || !Number.isFinite(replies) || replies <= 0) return tweet;
    if (captureStopped(budget?.signal, budget?.deadlineAt)) return tweet;
    const navigateTimeout = commandTimeout(EXTRACT_TIMEOUT_MS, budget?.deadlineAt);
    if (!navigateTimeout) return tweet;
    try {
      await session.navigate(tweet.tweet_url, stepOptions(navigateTimeout, budget));
      await wait(1_500, budget?.signal);
      if (captureStopped(budget?.signal, budget?.deadlineAt)) return tweet;
      const comments = await readStatusComments(session, tweet.tweet_id, budget);
      return { ...tweet, comments, comments_checked: true };
    } catch {
      return { ...tweet, comments_checked: true };
    }
  }

  return {
    async fetchHomeTimeline({ feed = 'for-you', limit = 50, excludeExternalIds = [], signal, deadlineAt } = {}) {
      const parsedLimit = Math.min(50, Math.max(1, Number(limit) || 50));
      const exclude = [...new Set((excludeExternalIds || []).map((id) => String(id || '')).filter(Boolean))];
      const budget = { signal, deadlineAt };
      return runtime.withSession({ purpose: 'x.home', focused: false }, async (session) => {
        let stoppedEarly = captureStopped(signal, deadlineAt);
        const stop = () => {
          if (!captureStopped(signal, deadlineAt)) return false;
          stoppedEarly = true;
          return true;
        };
        const homeTimeout = commandTimeout(45_000, deadlineAt);
        if (stoppedEarly || !homeTimeout) {
          return {
            source: 'browser_runtime_home', feed, logged_in: false, login_wall: false,
            page_url: null, page_title: null, selected_tab: null, tweet_count: 0, tweets: [],
            error: 'deadline', deadline: true,
          };
        }
        await session.navigate('https://x.com/home', {
          ...stepOptions(homeTimeout, budget),
          waitUntil: 'domcontentloaded',
        });
        if (!stop()) await wait(3_500, signal);
        const inspectTimeout = () => commandTimeout(EXTRACT_TIMEOUT_MS, deadlineAt);
        const inspectHome = async () => {
          const timeoutMs = inspectTimeout();
          if (!timeoutMs) return null;
          let inspect = await session.evaluate(buildPageInspectExpression(feed), stepOptions(timeoutMs, budget));
          if (inspect?.clicked_tab && !stop()) {
            await wait(2_500, signal);
            const again = inspectTimeout();
            if (again) inspect = { ...inspect, ...(await session.evaluate(buildPageInspectExpression(feed), stepOptions(again, budget))), clicked_tab: inspect.clicked_tab };
          }
          return inspect;
        };
        let inspect = stop() ? null : await inspectHome();
        if (!stop() && inspectMatchesRequestedFeed(inspect, feed) === false) {
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
            deadline: stoppedEarly,
          };
        }
        let items = [];
        const harvest = () => harvestTweets(session, budget);
        const merge = (current, incoming) => mergeTweets(current, incoming, parsedLimit, { excludeExternalIds: exclude });
        if (!stop()) items = merge(items, await harvest());
        let stale = 0;
        const maxRounds = exclude.length ? 20 : 8;
        for (let round = 0; round < maxRounds && items.length < parsedLimit; round += 1) {
          if (stop()) break;
          const scrollTimeout = commandTimeout(EXTRACT_TIMEOUT_MS, deadlineAt);
          if (!scrollTimeout) { stoppedEarly = true; break; }
          const before = items.length;
          await session.evaluate(buildScrollExpression(), stepOptions(scrollTimeout, budget));
          await wait(1_800, signal);
          if (stop()) break;
          items = merge(items, await harvest());
          if (items.length === before) {
            stale += 1;
            if (stale >= 2) break;
          } else {
            stale = 0;
          }
        }
        let focusPlan = { mode: 'all', items };
        if (typeof options.scoreHomeCards === 'function' && !stop()) {
          const reservedDeadline = Number.isFinite(Number(deadlineAt)) ? Number(deadlineAt) - EXPAND_TIME_RESERVE_MS : deadlineAt;
          const skipScore = Number.isFinite(Number(reservedDeadline)) && Date.now() >= Number(reservedDeadline);
          if (skipScore) {
            focusPlan = feed === 'following'
              ? { mode: 'following', items }
              : fallbackFocusExpansions(items, options.focusKeywords || []);
          } else {
            try {
              const scored = await options.scoreHomeCards(
                items.map((item) => ({ id: item.tweet_id, text: String(item.text || '') })),
                { deadlineAt: reservedDeadline, signal },
              );
              if (feed === 'following') {
                const attached = selectFocusExpansions(items, scored);
                focusPlan = scored ? { mode: 'following', items: attached.items } : { mode: 'all', items: attached.items };
              } else {
                focusPlan = selectFocusExpansions(items, scored);
              }
            } catch (error) {
              if (abortedError(error)) throw error;
              focusPlan = feed === 'following'
                ? { mode: 'following', items }
                : fallbackFocusExpansions(items, options.focusKeywords || []);
            }
          }
        }
        items = focusPlan.items;
        const selected = (tweet) => focusPlan.mode === 'all' || focusPlan.mode === 'following' || focusPlan.expandIds.has(tweet.tweet_id);
        const truncatedAll = items.filter((item) => looksTruncatedTweet(item));
        const cap = feed === 'following' ? FOLLOWING_EXPAND_CAP : FOR_YOU_TRUNCATED_CAP;
        const queued = rankTruncatedExpansions(truncatedAll).slice(0, cap);
        const reasons = {};
        const bump = (reason) => { reasons[reason] = (reasons[reason] || 0) + 1; };
        const overCap = truncatedAll.length - queued.length;
        if (overCap > 0) reasons['over-cap'] = overCap;
        let attempted = 0;
        let ok = 0;
        let failed = 0;
        let cursor = 0;
        for (; cursor < queued.length; cursor += 1) {
          if (stop()) break;
          const tweet = queued[cursor];
          attempted += 1;
          let completed = tweet;
          let reason = '';
          try {
            if (!tweet?.tweet_url) reason = 'no-url';
            else if (captureStopped(budget.signal, budget.deadlineAt) || !commandTimeout(EXTRACT_TIMEOUT_MS, budget.deadlineAt)) reason = 'deadline';
            else {
              completed = await completeTruncatedTweet(session, tweet, budget);
              const still = looksTruncatedTweet(completed || tweet);
              const stopped = captureStopped(budget.signal, budget.deadlineAt) || !commandTimeout(EXTRACT_TIMEOUT_MS, budget.deadlineAt);
              if (!still) reason = '';
              else if (stopped) reason = 'deadline';
              else if (!String(completed?.text || '').trim()) reason = 'extract-failed';
              else reason = 'still-truncated';
            }
          } catch (error) {
            if (abortedError(error) || captureStopped(budget.signal, budget.deadlineAt)) {
              reason = 'deadline';
              completed = tweet;
              bump(reason);
              failed += 1;
              items = items.map((item) => (item.tweet_id === tweet.tweet_id ? { ...completed, x_focus: item.x_focus } : item));
              cursor += 1;
              break;
            }
            reason = /extract/i.test(String(error?.message || '')) ? 'extract-failed' : 'navigate-failed';
            completed = tweet;
          }
          if (reason) { bump(reason); failed += 1; }
          else ok += 1;
          items = items.map((item) => (item.tweet_id === tweet.tweet_id ? { ...completed, x_focus: item.x_focus } : item));
        }
        for (let rest = cursor; rest < queued.length; rest += 1) {
          bump('deadline');
          failed += 1;
        }
        const writeLog = typeof options.log === 'function' ? options.log : console.log;
        try {
          writeLog(formatXExpandLog({
            feed, truncated: truncatedAll.length, attempted, ok, failed, reasons,
          }));
        } catch { /* a log failure must not drop the timeline */ }
        const withArticles = items.filter((item) => selected(item) && looksLikeArticleTweet(item)).slice(0, 12);
        for (const tweet of withArticles) {
          if (stop()) break;
          const completed = await completeArticleTweet(session, tweet, budget);
          items = items.map((item) => (item.tweet_id === tweet.tweet_id ? { ...completed, x_focus: item.x_focus } : item));
        }
        const needsComments = items.filter((item) => {
          const replies = Number(item.reply_count);
          return selected(item) && !item.comments_checked && item.tweet_url && Number.isFinite(replies) && replies > 0;
        });
        for (const tweet of needsComments) {
          if (stop()) break;
          const completed = await attachStatusComments(session, tweet, budget);
          items = items.map((item) => (item.tweet_id === tweet.tweet_id ? completed : item));
        }
        const loggedIn = Boolean(inspect?.logged_in);
        const loginWall = Boolean(inspect?.login_wall);
        const tweets = items.slice(0, parsedLimit).map((item) => ({
          tweet_id: item.tweet_id,
          tweet_url: item.tweet_url,
          text: appendUnscrapedMediaNotes(appendCommentsToBody(item.text, item.comments), {
            ...item,
            article_unfetched: Boolean(item.article_unfetched || item.article_cover),
          }),
          author_handle: item.author_handle,
          author_name: item.author_name,
          author_rest_id: item.author_rest_id,
          author_avatar: item.author_avatar,
          reposter_handle: item.reposter_handle,
          reposter_name: item.reposter_name,
          reposter_rest_id: item.reposter_rest_id,
          reposter_avatar: item.reposter_avatar,
          published_at: item.published_at,
          published_timestamp: item.published_timestamp,
          text_source: item.text_source,
          capture_context: buildXCaptureContext(item),
          ...(item.x_focus ? { x_focus: item.x_focus } : {}),
          ...(xVideoFromExtract(item) ? { x_video: xVideoFromExtract(item) } : {}),
        }));
        return {
          source: 'browser_runtime_home',
          feed,
          logged_in: loggedIn,
          login_wall: loginWall,
          page_url: inspect?.url || null,
          page_title: inspect?.title || null,
          selected_tab: inspect?.selected_tab || null,
          tweet_count: tweets.length,
          tweets,
          deadline: stoppedEarly,
          error: stoppedEarly && !tweets.length && loggedIn
            ? 'deadline'
            : loggedIn ? null : loginWall ? 'login_required' : 'login_state_unclear',
        };
      });
    },
  };
}
