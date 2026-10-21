import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/database/src/index.js';
import {
  buildXLinkPublisherIndex,
  canonicalArticleUrl,
  chooseOutboundUrl,
  extractOutboundUrls,
  matchMediaOutlet,
  readingLinkLabel,
  xLinkArticleEnabled,
} from '../packages/domain/src/x-link-articles.js';
import { createXLinkService } from '../packages/domain/src/x-link-service.js';
import { fetchLinkedArticle } from '../packages/connectors/src/x/link-fetch.js';
import { runXLinkArticle } from '../packages/runtime/src/x-link-article-job.js';
import { xLinkReaderScope, xPostHasOutboundLink } from '../apps/web/public/x-link-article.js';

const TWEET = '1234567890123456789';
const publishers = buildXLinkPublisherIndex([{
  sourceKey: 'bbc',
  publisher: 'BBC',
  publisherKey: 'bbc',
  channelName: 'BBC World',
  articleHosts: ['www.bbc.com'],
  redirectHosts: ['www.bbc.com'],
}]);

function openStore() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'x-link-article-'));
  const store = createStore(path.join(directory, 'test.db'));
  return {
    directory,
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function paragraph(text) {
  return `<p class="ssrcss-Paragraph">${text}</p>`;
}

function bbcPage(body) {
  return `<article>${body}</article>`;
}

const STORY = 'The central bank kept rates unchanged and described the labour market as solid. ';

function htmlResponse(html, status = 200) {
  return {
    status,
    headers: { get: (name) => (name === 'content-type' ? 'text/html' : '') },
    arrayBuffer: async () => Buffer.from(html),
  };
}

function redirect(location) {
  return {
    status: 301,
    headers: { get: (name) => (name === 'location' ? location : '') },
    body: { cancel: async () => {} },
  };
}

function lookupPublic() {
  return [{ address: '93.184.216.34' }];
}

test('media outlet handles match configured publishers and short links get a publisher label', () => {
  assert.equal(matchMediaOutlet({ handle: 'BBCWorld', name: 'BBC World' }, publishers)?.label, 'BBC');
  assert.equal(matchMediaOutlet({ handle: 'alice', name: 'Alice' }, publishers), null);
  assert.equal(matchMediaOutlet({ handle: 'bbcfan', name: 'BBC Fan' }, publishers), null);
  assert.equal(readingLinkLabel('BBC'), '阅读 BBC 原文');
  assert.equal(xLinkArticleEnabled({ AI_CENTER_X_LINK_ARTICLE: '0' }), false);
  assert.equal(xLinkArticleEnabled({}), true);
});

test('reader scope does not call a link post complete until the Chinese article is ready', () => {
  const post = { platform: 'x', body: 'One line https://t.co/abc' };
  assert.equal(xLinkReaderScope(post, null), '仅帖文');
  assert.equal(xLinkReaderScope(post, { status: 'pending', eligible: true }), '正在获取');
  assert.equal(xLinkReaderScope(post, { status: 'paywall', finalUrl: 'https://www.bbc.com/news/story', linkLabel: '阅读 BBC 原文' }), '仅帖文');
  assert.equal(xLinkReaderScope(post, { status: 'ready', body: '中文正文' }), '正文完整');
  assert.equal(xLinkReaderScope(post, { eligible: false, status: 'ineligible' }), null);
  assert.equal(xLinkReaderScope({ platform: 'x', body: '没有链接' }, null), null);
  const plain = { platform: 'x', body: 'Read more: bbc.in/47XDz70' };
  assert.equal(xPostHasOutboundLink(plain), true);
  assert.equal(xPostHasOutboundLink({ platform: 'x', body: 'pic.x.com/QJHsnY4YwJ' }), false);
  assert.equal(xLinkReaderScope(plain, null), '仅帖文');
});

test('linked article fetch follows t.co without cookies and stops on paywall, private hosts, and other domains', async () => {
  const calls = [];
  const story = bbcPage(`${paragraph(STORY.repeat(4))}${paragraph(STORY.repeat(4))}`);
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), headers: options.headers, redirect: options.redirect });
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(Object.keys(options.headers).some((key) => key.toLowerCase() === 'cookie'), false);
    if (String(url).startsWith('https://t.co/')) return redirect('https://www.bbc.com/news/story?utm_source=twitter');
    return htmlResponse(story);
  };
  const article = await fetchLinkedArticle({
    url: 'https://t.co/abc',
    allowedHosts: ['www.bbc.com'],
    publisherForHost: () => ({ sourceKey: 'bbc', publisherKey: 'bbc' }),
    fetchImpl,
    lookupImpl: lookupPublic,
  });
  assert.equal(article.ok, true);
  assert.equal(article.contentLevel, 'full');
  assert.match(article.finalUrl, /^https:\/\/www\.bbc\.com\/news\/story/);
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(calls.some((call) => call.url.startsWith('https://www.bbc.com/')), true);

  const paywall = await fetchLinkedArticle({
    url: 'https://t.co/pay',
    allowedHosts: ['www.bbc.com'],
    publisherForHost: () => ({ sourceKey: 'bbc', publisherKey: 'bbc' }),
    fetchImpl: async (url) => String(url).startsWith('https://t.co/')
      ? redirect('https://www.bbc.com/news/paid')
      : htmlResponse(`<div class="paywall">Subscribe</div>${story}`),
    lookupImpl: lookupPublic,
  });
  assert.equal(paywall.ok, false);
  assert.equal(paywall.reason, 'paywall');
  assert.match(paywall.finalUrl, /bbc\.com/);

  let fetched = false;
  const blocked = await fetchLinkedArticle({
    url: 'https://t.co/evil',
    allowedHosts: ['www.bbc.com'],
    fetchImpl: async () => { fetched = true; return redirect('https://evil.example/story'); },
    lookupImpl: async (host) => (host === 'evil.example' ? [{ address: '203.0.113.8' }] : [{ address: '127.0.0.1' }]),
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'blocked_host');
  assert.equal(fetched, false);

  const foreign = await fetchLinkedArticle({
    url: 'https://t.co/other',
    allowedHosts: ['www.bbc.com'],
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://evil.example/')) throw new Error('不应抓取白名单外的正文');
      return redirect('https://evil.example/story');
    },
    lookupImpl: lookupPublic,
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'blocked_host');
});

test('only a media author is queued, and a fetched article is translated once', async () => {
  const opened = openStore();
  const jobs = [];
  const store = {
    listOpenJobs: () => jobs.filter((job) => job.status === 'queued'),
    createJob(input) {
      const job = { id: `job-${jobs.length}`, workspaceId: input.workspaceId, input: input.input, status: 'queued' };
      jobs.push(job);
      return job;
    },
  };
  const captures = new Map();
  function feedFor(handle, name, body) {
    return {
      getCapture() {
        return { id: 'cap', metadata: { authorHandle: handle, authorName: name }, title: name };
      },
      getContentItemByCaptureId() {
        return { id: 'item-1', body, title: name };
      },
    };
  }
  try {
    const off = createXLinkService({
      repository: opened.store.repositories.xLinks,
      feedRepository: feedFor('BBCWorld', 'BBC World', `Headline https://t.co/abc`),
      store,
      publishers,
      env: { AI_CENTER_X_LINK_ARTICLE: '0' },
    });
    assert.equal(off.enqueue('local', { tweetId: TWEET }).status, 'disabled');
    assert.equal(jobs.length, 0);

    const person = createXLinkService({
      repository: opened.store.repositories.xLinks,
      feedRepository: feedFor('alice', 'Alice', 'look https://t.co/abc'),
      store,
      publishers,
      env: {},
    });
    assert.equal(person.enqueue('local', { tweetId: TWEET }).eligible, false);
    assert.equal(opened.store.repositories.xLinks.get('local', TWEET), null);

    const service = createXLinkService({
      repository: opened.store.repositories.xLinks,
      feedRepository: feedFor('BBCWorld', 'BBC World', 'Markets moved. https://t.co/abc'),
      store,
      publishers,
      env: { AI_CENTER_X_LINK_ARTICLE_DAILY: '1' },
    });
    const queued = service.enqueue('local', { tweetId: TWEET });
    assert.equal(queued.eligible, true);
    assert.equal(queued.status, 'pending');
    assert.equal(jobs.length, 1);
    service.enqueue('local', { tweetId: TWEET });
    assert.equal(jobs.length, 1);

    let translations = 0;
    const story = bbcPage(`${paragraph(STORY.repeat(4))}${paragraph(STORY.repeat(4))}`);
    const fetchArticle = (input) => fetchLinkedArticle({
      ...input,
      fetchImpl: async (url) => String(url).startsWith('https://t.co/')
        ? redirect('https://www.bbc.com/news/story')
        : htmlResponse(story),
      lookupImpl: lookupPublic,
    });
    const translate = { translate: async () => { translations += 1; return { translatedText: '央行维持利率不变，并称劳动力市场依然稳健。' }; } };
    const ready = await runXLinkArticle({
      repository: opened.store.repositories.xLinks,
      publishers,
      translate,
      fetchArticle,
      env: { AI_CENTER_X_LINK_ARTICLE_DAILY: '1' },
      workspaceId: 'local',
      tweetId: TWEET,
    });
    assert.equal(ready.status, 'ready');
    assert.equal(translations, 1);
    const row = opened.store.repositories.xLinks.get('local', TWEET);
    assert.equal(row.linkLabel, '阅读 BBC 原文');
    assert.match(row.finalUrl, /www\.bbc\.com\/news\/story/);
    assert.match(row.bodyZh, /央行/);
    assert.equal(service.get('local', TWEET).body, row.bodyZh);

    captures.set('second', true);
    const second = '1234567890123456790';
    opened.store.repositories.xLinks.save({
      workspaceId: 'local',
      tweetId: second,
      sourceUrl: 'https://t.co/again',
      status: 'pending',
    });
    const copied = await runXLinkArticle({
      repository: opened.store.repositories.xLinks,
      publishers,
      translate,
      fetchArticle,
      env: { AI_CENTER_X_LINK_ARTICLE_DAILY: '1' },
      workspaceId: 'local',
      tweetId: second,
    });
    assert.equal(copied.status, 'ready');
    assert.equal(copied.copied, true);
    assert.equal(translations, 1);
    assert.equal(opened.store.repositories.xLinks.get('local', second).linkLabel, '阅读 BBC 原文');
  } finally {
    opened.close();
  }
});

test('a paywall keeps the original link and is not marked ready', async () => {
  const opened = openStore();
  try {
    opened.store.repositories.xLinks.save({
      workspaceId: 'local',
      tweetId: TWEET,
      sourceUrl: 'https://t.co/pay',
      publisher: 'BBC',
      status: 'pending',
    });
    const story = bbcPage(`${paragraph(STORY.repeat(3))}${paragraph(STORY.repeat(3))}`);
    let translations = 0;
    const result = await runXLinkArticle({
      repository: opened.store.repositories.xLinks,
      publishers,
      translate: { translate: async () => { translations += 1; return { translatedText: '不应出现' }; } },
      fetchArticle: (input) => fetchLinkedArticle({
        ...input,
        fetchImpl: async (url) => String(url).startsWith('https://t.co/')
          ? redirect('https://www.bbc.com/news/paid')
          : htmlResponse(`<div class="paywall">Subscribe</div>${story}`),
        lookupImpl: lookupPublic,
      }),
      workspaceId: 'local',
      tweetId: TWEET,
    });
    assert.equal(result.status, 'paywall');
    assert.equal(translations, 0);
    const row = opened.store.repositories.xLinks.get('local', TWEET);
    assert.equal(row.status, 'paywall');
    assert.equal(row.linkLabel, '阅读 BBC 原文');
    assert.equal(row.bodyZh, '');
  } finally {
    opened.close();
  }
});

test('plain text and bbc.in hops reach the BBC article and keep a reading link before translation', async () => {
  const text = 'Read more: bbc.in/47XDz70';
  const urls = extractOutboundUrls(text);
  assert.deepEqual(urls, ['https://bbc.in/47XDz70']);
  assert.equal(chooseOutboundUrl(['https://t.co/abc', ...urls]), 'https://bbc.in/47XDz70');
  assert.equal(extractOutboundUrls('watch pic.x.com/QJHsnY4YwJ').length, 0);
  const canonical = canonicalArticleUrl('https://www.bbc.com/news/articles/abc?at_medium=social&xtor=AL-71&utm_source=twitter');
  assert.equal(canonical, 'https://www.bbc.com/news/articles/abc');

  const calls = [];
  const story = bbcPage(`${paragraph(STORY.repeat(4))}${paragraph(STORY.repeat(4))}`);
  const article = await fetchLinkedArticle({
    url: 'https://t.co/MVj4mMZ36G',
    allowedHosts: ['www.bbc.com'],
    publisherForHost: () => ({ sourceKey: 'bbc', publisherKey: 'bbc' }),
    fetchImpl: async (url, options) => {
      calls.push(String(url));
      assert.equal(options.headers.Cookie, undefined);
      if (String(url).startsWith('https://t.co/')) return redirect('https://bbc.in/4yWhqSC');
      if (String(url).startsWith('https://bbc.in/')) return redirect('https://trib.al/D0IB5sG');
      if (String(url).startsWith('https://trib.al/')) {
        return redirect('https://www.bbc.com/news/articles/abc?at_medium=social&xtor=AL-71');
      }
      return htmlResponse(story);
    },
    lookupImpl: lookupPublic,
  });
  assert.equal(article.ok, true);
  assert.match(article.finalUrl, /^https:\/\/www\.bbc\.com\/news\/articles\/abc/);
  assert.equal(calls.some((url) => url.startsWith('https://bbc.in/')), true);
  assert.equal(calls.some((url) => url.startsWith('https://trib.al/')), true);

  const opened = openStore();
  const jobs = [];
  const captures = new Map();
  const plainId = '2111969849165377774';
  const secondId = '2110738045825593390';
  captures.set(plainId, {
    id: 'cap-plain',
    metadata: { authorHandle: 'BBCWorld', authorName: 'BBC News (World)', card_url: '' },
    title: 'BBC',
  });
  captures.set(secondId, {
    id: 'cap-second',
    metadata: { authorHandle: 'BBCWorld', authorName: 'BBC News (World)' },
    title: 'BBC',
  });
  const bodies = new Map([
    ['cap-plain', { id: 'item-plain', body: text, title: 'BBC' }],
    ['cap-second', { id: 'item-second', body: 'Headline https://t.co/MVj4mMZ36G', title: 'BBC' }],
  ]);
  const store = {
    listOpenJobs: () => jobs.filter((job) => job.status === 'queued'),
    createJob(input) {
      const job = { id: `job-${jobs.length}`, workspaceId: input.workspaceId, input: input.input, status: 'queued' };
      jobs.push(job);
      return job;
    },
  };
  try {
    const service = createXLinkService({
      repository: opened.store.repositories.xLinks,
      feedRepository: {
        listRecentXCaptures() {
          return [
            { externalId: plainId },
            { externalId: secondId },
            { externalId: '2110000000000000001' },
          ];
        },
        getCapture(_workspaceId, _provider, id) {
          return captures.get(id) || (id === '2110000000000000001'
            ? { id: 'cap-person', metadata: { authorHandle: 'alice', authorName: 'Alice' }, title: 'Alice' }
            : null);
        },
        getContentItemByCaptureId(_workspaceId, id) {
          return bodies.get(id) || { id: 'item-person', body: 'hello https://example.com/a', title: 'Alice' };
        },
      },
      store,
      publishers,
      env: { AI_CENTER_X_LINK_ARTICLE_DAILY: '1' },
    });
    const queued = service.enqueue('local', { tweetId: plainId });
    assert.equal(queued.status, 'pending');
    assert.equal(queued.linkLabel, '阅读 BBC 原文');
    assert.equal(queued.finalUrl, 'https://bbc.in/47XDz70');
    opened.store.repositories.xLinks.save({
      workspaceId: 'local',
      tweetId: secondId,
      sourceUrl: 'https://t.co/MVj4mMZ36G',
      publisher: 'BBC',
      status: 'failed',
      reason: 'blocked_host',
      attempts: 3,
    });
    const preview = service.backfill('local', { dryRun: true });
    assert.equal(preview.queued.length, 0);
    jobs.length = 0;
    opened.store.repositories.xLinks.save({
      workspaceId: 'local',
      tweetId: plainId,
      status: 'failed',
      reason: 'blocked_host',
      attempts: 3,
      sourceUrl: 'https://bbc.in/47XDz70',
      publisher: 'BBC',
      linkLabel: '',
      finalUrl: '',
    });
    const filled = service.backfill('local', { dryRun: false });
    assert.equal(filled.queued.length, 1);
    assert.equal(filled.queued[0].tweetId, plainId);
    assert.equal(filled.skipped.some((row) => row.tweetId === secondId && row.reason === 'daily-limit'), true);
    assert.equal(filled.skipped.some((row) => row.reason === 'ineligible'), true);
    assert.equal(jobs.length, 1);
  } finally {
    opened.close();
  }
});
