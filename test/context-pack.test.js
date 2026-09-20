import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextService, formatPackTime, formatReferencePack } from '../packages/domain/src/context-service.js';

const generatedAt = Date.UTC(2026, 8, 19, 5, 42);

function emptyTrading() {
  return { async getHoldingsBoard() { return null; } };
}

test('reference pack markdown keeps date, source link and translation', () => {
  const markdown = formatReferencePack([{
    typeLabel: '信息',
    title: 'SK海力士',
    occurredAt: Date.UTC(2026, 8, 18, 4, 0),
    authorName: 'chipdesk',
    sourceUrl: 'https://x.com/a/status/1',
    translatedText: '海力士推进 HBM4。',
    originalText: 'SK Hynix pushes HBM4.',
    content: '海力士推进 HBM4。',
  }], { generatedAt });
  assert.match(markdown, /^# 材料包/m);
  assert.match(markdown, /导出时间：/);
  assert.match(markdown, /## 1\. 信息 · SK海力士/);
  assert.match(markdown, /日期：/);
  assert.match(markdown, /作者：chipdesk/);
  assert.match(markdown, /来源：https:\/\/x.com\/a\/status\/1/);
  assert.match(markdown, /### 译文\n海力士推进 HBM4。/);
  assert.match(markdown, /### 原文\nSK Hynix pushes HBM4\./);
  assert.equal(formatPackTime(0), '');
});

test('context service packs selected feed items without a new domain', async () => {
  const service = createContextService({
    knowledgeService: {
      getInspiration() { return { id: 'note-1', title: '', body: '关注供给', sourceUrl: 'https://x.com/b', createdAt: 2 }; },
      search() { return []; },
    },
    feedService: {
      getLocalizedContentItem(_workspaceId, id) {
        if (id !== 'content-1') return null;
        return {
          id: 'content-1',
          title: 'SK海力士',
          body: 'SK Hynix pushes HBM4.',
          authorName: 'chipdesk',
          sourceUrl: 'https://x.com/a/status/1',
          publishedAt: Date.UTC(2026, 8, 18, 4, 0),
          createdAt: Date.UTC(2026, 8, 18, 4, 0),
          translation: { text: '海力士推进 HBM4。', engine: 'gemini', targetLang: 'zh' },
        };
      },
      getContentItem() { return null; },
      listContentItems() { return []; },
    },
    tradingService: emptyTrading(),
  });
  const pack = await service.packReferences({
    workspaceId: 'local',
    references: [
      { resourceType: 'content-item', resourceId: 'content-1' },
      { resourceType: 'inspiration', resourceId: 'note-1' },
    ],
  });
  assert.equal(pack.itemCount, 2);
  assert.equal(pack.title, 'SK海力士 等 2 条');
  assert.equal(pack.items[0].hasTranslation, true);
  assert.equal(pack.items[0].sourceUrl, 'https://x.com/a/status/1');
  assert.match(pack.markdown, /海力士推进 HBM4。/);
  assert.match(pack.markdown, /关注供给/);
  assert.match(pack.markdown, /来源：https:\/\/x.com\/b/);
});
