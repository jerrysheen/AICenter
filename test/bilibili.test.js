import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseAiZhSubtitle,
  createBilibiliService,
  extractBvid,
  fetchBilibiliAiSubtitle,
  subtitleBodyToText,
  unwrapMarkdownFence,
  videoToFeedItem,
} from '../packages/connectors/src/bilibili/index.js';
import { createConnectorRegistry } from '../packages/connectors/src/index.js';

test('bilibili urls and share text resolve to a BV id', () => {
  const samples = [
    'https://www.bilibili.com/video/BV1cwtN6sEDr/?trackid=web_pegasus_0.router-web-pegasus-2479516-sm4rx.1789543740069.937&spm_id_from=333.1007.tianma.1-2-2.click&vd_source=5b548782c91abaad49c0818a7ab17c83',
    '【研读1081份专利后，我终于搞懂了华为为什么要做阔直板】 https://www.bilibili.com/video/BV1cwtN6sEDr/?share_source=copy_web&vd_source=c5f36e7b9a1c5dc82920a822a608e342',
    '【研读1081份专利后，我终于搞懂了华为为什么要做阔直板-哔哩哔哩】 https://b23.tv/BV1cwtN6sEDr',
  ];
  for (const sample of samples) {
    assert.equal(extractBvid(sample), 'BV1cwtN6sEDr');
  }
});

test('only ai-zh subtitle tracks are accepted', () => {
  assert.equal(chooseAiZhSubtitle([{ lan: 'zh' }, { lan: 'ai-en' }]), null);
  assert.equal(chooseAiZhSubtitle([{ lan: 'ai-zh', subtitle_url: 'https://example/ai' }]).lan, 'ai-zh');
  assert.equal(subtitleBodyToText([{ content: '你好' }, { content: '世界' }]), '你好 世界');
});

test('bilibili transcript maps to a feed item without chrome fields', () => {
  const item = videoToFeedItem({
    bvid: 'BV1cwtN6sEDr',
    title: '研读专利',
    owner: '结构笔记',
    url: 'https://www.bilibili.com/video/BV1cwtN6sEDr',
    publishedAt: 1_000,
    fullText: '正文来自 AI 中文字幕',
  });
  assert.equal(item.platform, 'bilibili');
  assert.equal(item.externalId, 'BV1cwtN6sEDr');
  assert.equal(item.contentType, 'transcript');
  assert.equal(item.body, '正文来自 AI 中文字幕');
  assert.equal('subtitle_url' in item, false);
  assert.equal('fullText' in item, false);
});

test('bilibili service returns 没有 when ai-zh is missing', async () => {
  const service = createBilibiliService({
    now: () => 1_000,
    client: {
      async fetchBilibiliAiSubtitle() {
        return {
          bvid: 'BV1cwtN6sEDr',
          title: '研读专利',
          fullText: '',
          status: 'subtitle_unavailable',
          error: '没有',
        };
      },
    },
  });
  const feed = await service.getFeed({ url: 'https://www.bilibili.com/video/BV1cwtN6sEDr', refresh: true });
  assert.equal(feed.mode, 'unavailable');
  assert.equal(feed.note, '没有');
  assert.equal(feed.items.length, 0);
});

test('bilibili service maps a live ai-zh transcript', async () => {
  const service = createBilibiliService({
    now: () => 1_000,
    formatter: {
      async formatTranscript(source) {
        return { text: `# 标题\n\n${source}`, engine: 'gemini' };
      },
    },
    client: {
      async fetchBilibiliAiSubtitle() {
        return {
          bvid: 'BV1cwtN6sEDr',
          title: '研读专利',
          owner: '结构笔记',
          url: 'https://www.bilibili.com/video/BV1cwtN6sEDr',
          publishedAt: 1_000,
          fullText: 'AI 中文字幕正文',
          status: 'ok',
        };
      },
    },
  });
  const feed = await service.getFeed({ url: 'BV1cwtN6sEDr', refresh: true });
  assert.equal(feed.mode, 'live');
  assert.equal(feed.items[0].originalText, 'AI 中文字幕正文');
  assert.equal(feed.items[0].body, '# 标题\n\nAI 中文字幕正文');
  assert.equal(feed.items[0].formatEngine, 'gemini');
});

test('markdown fence unwrap keeps inner headings', () => {
  assert.equal(unwrapMarkdownFence('```markdown\n# 标题\n正文\n```'), '# 标题\n正文');
});

test('bilibili connector registers feed.bilibili.sync', () => {
  const registry = createConnectorRegistry({
    syncFeed: async () => ({ mode: 'live', items: [], tweetCount: 0, note: '' }),
  });
  const types = registry.listModules().flatMap((module) => module.jobTypes);
  assert.ok(types.includes('feed.bilibili.sync'));
});

test('ai-zh fetch uses player payload and ignores normal zh tracks', async () => {
  const result = await fetchBilibiliAiSubtitle('BV1cwtN6sEDr', {
    getJson: async (url) => {
      if (String(url).includes('/x/web-interface/view')) {
        return {
          code: 0,
          data: {
            title: '研读专利',
            cid: 1,
            pubdate: 1,
            owner: { name: '结构笔记' },
          },
        };
      }
      return { body: [{ content: 'AI字幕一句' }, { content: 'AI字幕二句' }] };
    },
    fetchJsonInBilibiliBrowser: async (url) => {
      if (String(url).includes('/x/player/')) {
        return {
          code: 0,
          data: {
            subtitle: {
              subtitles: [
                { lan: 'zh', lan_doc: '中文', subtitle_url: 'https://example/zh.json' },
                { lan: 'ai-zh', lan_doc: '中文（AI）', subtitle_url: 'https://example/ai.json' },
              ],
            },
          },
        };
      }
      throw new Error('subtitle should download over HTTP');
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.hasAiZh, true);
  assert.equal(result.fullText, 'AI字幕一句 AI字幕二句');
});
