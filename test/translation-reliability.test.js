import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createStore } from '../packages/database/src/index.js';
import { TRANSLATION_MAX_ATTEMPTS, translationRetryDelayMs } from '../packages/database/src/translation-retry.js';
import { cleanIngestExcerpt } from '../packages/connectors/src/excerpt-text.js';
import { createGemmaTranslationRouter } from '../packages/connectors/src/translate/gemma.js';
import { createFeedService } from '../packages/domain/src/feed-service.js';
import { createJobRunner } from '../packages/runtime/src/job-runner.js';

function temporaryStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'translation-reliability-'));
  const store = createStore(path.join(dir, 'test.db'));
  return { dir, store, remove() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('translation retry delay doubles and stops at five minutes', () => {
  assert.equal(translationRetryDelayMs(1), 1_000);
  assert.equal(translationRetryDelayMs(2), 2_000);
  assert.equal(translationRetryDelayMs(3), 4_000);
  assert.equal(TRANSLATION_MAX_ATTEMPTS, 4);
  assert.equal(translationRetryDelayMs(20), 5 * 60_000);
});

test('failed translation is stored, retried with backoff, then stays failed', async () => {
  const temporary = temporaryStore();
  try {
    const store = temporary.store;
    const text = 'Executive order on coastal security measures.';
    const job = store.createJob({
      type: 'feed.translation.run', workspaceId: 'local', maxAttempts: TRANSLATION_MAX_ATTEMPTS,
      input: { targetLang: 'zh', items: [{ id: 'rel-1', text }] },
    });
    const runner = createJobRunner({
      store,
      handlers: { 'feed.translation.run': async () => { throw new Error('Gemma 翻译失败（500）'); } },
    });
    for (let attempt = 1; attempt <= TRANSLATION_MAX_ATTEMPTS; attempt += 1) {
      await runner.runOnce();
      const current = store.getJob(job.id);
      const failure = store.repositories.feed.listTranslationFailures('local', ['rel-1'])[0];
      assert.equal(failure.attemptCount, attempt);
      assert.match(failure.lastError, /500/);
      if (attempt < TRANSLATION_MAX_ATTEMPTS) {
        assert.equal(current.status, 'queued');
        assert.equal(failure.nextRetryAt, current.availableAt);
        assert.ok(failure.nextRetryAt > Date.now());
        store.rescheduleQueuedJobs('local', [{ id: job.id, availableAt: 0, expectedAvailableAt: current.availableAt }]);
      } else {
        assert.equal(current.status, 'failed');
        assert.equal(failure.nextRetryAt, null);
      }
    }
    const service = createFeedService({
      legacyRepository: store, feedRepository: store.repositories.feed, sourcePort: {},
      translationPort: { translateMany: async () => { throw new Error('should not translate while failed'); } },
    });
    const blocked = await service.localizeTexts([{ id: 'rel-1', text }], { workspaceId: 'local' });
    assert.equal(blocked.localizations['rel-1'].status, 'failed');
    assert.equal(blocked.localizations['rel-1'].pending, false);
    assert.equal(blocked.localizations['rel-1'].text, '');
    assert.deepEqual(blocked.pendingIds, []);
  } finally { temporary.remove(); }
});

test('a saved translation clears the failure, and an hourly title is reused without calling Gemma', async () => {
  const temporary = temporaryStore();
  try {
    const store = temporary.store;
    const text = 'Homeland Security Department proposed rule.';
    store.repositories.feed.noteTranslationFailure({
      workspaceId: 'local', items: [{ id: 'rel-2', text }], error: new Error('Gemma 翻译失败（500）'),
      attemptCount: 1, terminal: false, nextRetryAt: Date.now() + 60_000,
    });
    store.repositories.feed.saveTranslations([{
      workspaceId: 'local', itemId: 'rel-2', targetLang: 'zh',
      sourceHash: store.repositories.feed.listTranslationFailures('local', ['rel-2'])[0].sourceHash,
      translatedText: '国土安全部拟议规则', engine: 'gemma-4-26b-a4b-it',
    }]);
    assert.equal(store.repositories.feed.listTranslationFailures('local', ['rel-2']).length, 0);

    let calls = 0;
    const service = createFeedService({
      legacyRepository: store, feedRepository: store.repositories.feed, sourcePort: {},
      normalizedArticlePort: { hourlyTitles: () => new Map([['official:rel-3', '白宫行政命令']]) },
      translationPort: { translateMany: async () => { calls += 1; throw new Error('duplicate translation'); } },
    });
    const reused = await service.localizeTexts([{ id: 'rel-3', text: 'Presidential document from the Executive Office.' }], { workspaceId: 'local' });
    assert.equal(calls, 0);
    assert.equal(reused.localizations['rel-3'].text, '白宫行政命令');
    assert.equal(reused.localizations['rel-3'].status, 'ready');
    assert.equal(reused.localizations['rel-3'].engine, 'hourly-report');
    assert.deepEqual(reused.pendingIds, []);

    const again = await service.localizeTexts([{ id: 'rel-4', text: 'Presidential document from the Executive Office.' }], { workspaceId: 'local' });
    assert.equal(calls, 0);
    assert.equal(again.localizations['rel-4'].text, '白宫行政命令');
    assert.equal(again.localizations['rel-4'].engine, 'hourly-report');
  } finally { temporary.remove(); }
});

test('same source hash is reused for another feed id', async () => {
  const temporary = temporaryStore();
  try {
    const store = temporary.store;
    const text = 'Federal Communications Commission notice.';
    const hash = store.repositories.feed.noteTranslationFailure({
      workspaceId: 'local', items: [{ id: 'unused', text: 'x' }], error: new Error('x'), attemptCount: 4, terminal: true,
    });
    assert.equal(hash[0].nextRetryAt, null);
    const { createHash } = await import('node:crypto');
    const sourceHash = createHash('sha256').update(text).digest('hex');
    store.repositories.feed.saveTranslations([{
      workspaceId: 'local', itemId: 'media:notice', targetLang: 'zh', sourceHash, translatedText: '联邦通信委员会通知', engine: 'gemma-4-26b-a4b-it',
    }]);
    let calls = 0;
    const service = createFeedService({
      legacyRepository: store, feedRepository: store.repositories.feed, sourcePort: {},
      translationPort: { translateMany: async () => { calls += 1; return { translations: [] }; } },
    });
    const result = await service.localizeTexts([{ id: 'rel-notice', text }], { workspaceId: 'local' });
    assert.equal(calls, 0);
    assert.equal(result.localizations['rel-notice'].text, '联邦通信委员会通知');
    assert.equal(result.localizations['rel-notice'].engine, 'gemma-4-26b-a4b-it');
  } finally { temporary.remove(); }
});

test('lease expiry records a translation failure instead of leaving the item in progress', () => {
  const temporary = temporaryStore();
  try {
    const store = temporary.store;
    const job = store.createJob({
      type: 'feed.translation.run', workspaceId: 'local', maxAttempts: TRANSLATION_MAX_ATTEMPTS,
      input: { items: [{ id: 'rel-lease', text: 'Interior Department notice about public lands.' }] },
    });
    const claimed = store.claimNextJob('worker-1', ['feed.translation.run']);
    assert.equal(claimed.id, job.id);
    assert.equal(store.recoverStaleJobs(1, claimed.lockedAt + 5), 1);
    const current = store.getJob(job.id);
    const failure = store.repositories.feed.listTranslationFailures('local', ['rel-lease'])[0];
    assert.equal(current.status, 'queued');
    assert.match(failure.lastError, /租约已过期/);
    assert.equal(failure.attemptCount, 1);
    assert.equal(failure.nextRetryAt, current.availableAt);
    assert.ok(current.availableAt > claimed.lockedAt);
  } finally { temporary.remove(); }
});

test('ingest excerpts decode entities and drop video player residue', () => {
  assert.equal(
    cleanIngestExcerpt('Coastal rule &amp; the Secretary&#39;s notice. Your browser does not support the video tag. Play Video'),
    "Coastal rule & the Secretary's notice.",
  );
  assert.equal(cleanIngestExcerpt('说明&amp;备注。您的浏览器不支持视频播放。'), '说明&备注。');
  assert.equal(cleanIngestExcerpt('A &amp;amp; B &#x27;quote&#x27;'), "A & B 'quote'");
});

test('Gemma upstream failure logs status and body without the API key', async () => {
  const temporary = temporaryStore();
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    const secret = 'AIzaSySECRETSECRETSECRET12';
    const router = createGemmaTranslationRouter({
      env: { GEMINI_API_KEY: secret },
      models: ['gemma-4-26b-a4b-it'],
      quotaRepository: temporary.store.repositories.modelQuota,
      fetch: async () => new Response(JSON.stringify({
        error: { code: 500, status: 'INTERNAL', message: `boom key=${secret}` },
      }), { status: 500 }),
    });
    await assert.rejects(router.generate({ system: '翻译', prompt: 'One original sentence.' }), /500/);
    const logged = lines.find((line) => line.includes('Gemma 翻译上游失败'));
    assert.match(logged, /status=500/);
    assert.match(logged, /INTERNAL/);
    assert.doesNotMatch(logged, /AIzaSySECRET/);
  } finally {
    console.error = original;
    temporary.remove();
  }
});

test('failed official rows show the original title and 暂未翻译', () => {
  const source = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const extract = (name) => {
    const result = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
    assert.ok(result, name);
    return result[0];
  };
  const context = vm.createContext({
    formatTime: () => '',
    state: {
      sourceLocalizations: {
        'doc-1': { id: 'doc-1', text: '', pending: false, status: 'failed', sourceText: 'Coastal security rule' },
        'doc-2': { id: 'doc-2', text: '', pending: true, status: 'pending', sourceText: 'Still waiting' },
      },
      sourceLocalizing: true,
    },
  });
  vm.runInContext(`${['localizedCopy', 'officialAsItem', 'officialEventMeta'].map(extract).join('\n')}\nthis.item=officialAsItem;this.meta=officialEventMeta;`, context);
  const failed = context.item({ releaseId: 'doc-1', title: 'Coastal security rule', authority: 'FCC', documentNumber: '2026-1', documentType: 'rule' });
  assert.equal(failed.title, 'Coastal security rule');
  assert.match(context.meta(failed), /^暂未翻译/);
  const waiting = context.item({ releaseId: 'doc-2', title: 'Still waiting', authority: 'Interior Department' });
  assert.equal(waiting.title, '正在翻译…');
  assert.doesNotMatch(context.meta(waiting), /暂未翻译/);
});
