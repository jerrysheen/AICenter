import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiCenterServer } from '../apps/web/src/server.js';
import {
  parseCreateAttachmentInput,
  parseCreateWorkPackageInput,
  parseContinueWorkPackageInput,
  ValidationError,
} from '../packages/contracts/src/index.js';
import { createAttachmentStore, createStore } from '../packages/database/src/index.js';
import { createKnowledgeService, sniffImageMime } from '../packages/domain/src/index.js';
import { buildCursorSessionPrompt } from '../packages/connectors/src/index.js';
import { createWorkPackageJobHandlers } from '../packages/runtime/src/work-package-module.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function temporaryWorkspace() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-attach-'));
  const store = createStore(path.join(directory, 'test.db'));
  const attachmentStore = createAttachmentStore({ dataDirectory: directory });
  const knowledge = createKnowledgeService({
    legacyRepository: store,
    knowledgeRepository: store.repositories.knowledge,
    attachmentStore,
  });
  return {
    directory,
    store,
    knowledge,
    remove() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('inspire composer dispatches to inspiration, task, or ask and previews local images', () => {
  const html = readFileSync(new URL('../apps/web/public/index.html', import.meta.url), 'utf8');
  const appJs = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="dispatch-plus"/);
  assert.match(html, /id="dispatch-image"/);
  assert.match(html, /id="dispatch-target"/);
  assert.match(html, /data-dispatch-target="inspiration"/);
  assert.match(html, /data-dispatch-target="task"/);
  assert.match(html, /data-dispatch-target="ask"/);
  assert.match(html, /id="note-image-input"/);
  assert.doesNotMatch(html, /id="task-form"/);
  assert.match(appJs, /createObjectURL/);
  assert.match(appJs, /composeTarget/);
  assert.match(appJs, /\/api\/v1\/attachments/);
  assert.match(appJs, /attachmentIds/);
});

test('attachment contract keeps page DTO free of host paths', () => {
  const parsed = parseCreateAttachmentInput({
    mime: 'image/png',
    originalName: 'shot.png',
    data: PNG_1X1.toString('base64'),
  });
  assert.equal(parsed.originalName, 'shot.png');
  assert.equal(parseCreateWorkPackageInput({ body: '带图修一下' }).attachmentIds.length, 0);
  assert.equal(parseContinueWorkPackageInput({ body: '继续', attachmentIds: [] }).attachmentIds.length, 0);
  assert.equal(parseContinueWorkPackageInput({ body: '继续' }).attachmentIds, undefined);
  assert.throws(() => parseCreateAttachmentInput({ data: '' }), ValidationError);
});

test('sniffImageMime accepts png and rejects plain text', () => {
  assert.equal(sniffImageMime(PNG_1X1), 'image/png');
  assert.equal(sniffImageMime(Buffer.from('not-an-image')), '');
});

test('knowledge service stores blobs and hands relative paths to CLI prompt', async () => {
  const temporary = temporaryWorkspace();
  try {
    const attachment = temporary.knowledge.createAttachment({
      workspaceId: 'local',
      originalName: 'bug.png',
      data: PNG_1X1.toString('base64'),
    });
    assert.equal(attachment.mime, 'image/png');
    assert.match(attachment.url, /^\/api\/v1\/attachments\/[0-9a-f-]{36}\/content$/i);
    assert.equal(attachment.relativePath, undefined);
    const onDisk = readFileSync(path.join(temporary.directory, 'blobs', 'attachments', `${attachment.id}.png`));
    assert.equal(onDisk.equals(PNG_1X1), true);

    const pack = temporary.knowledge.createWorkPackage({
      body: '筛选按钮错位，见图',
      attachmentIds: [attachment.id],
    });
    assert.equal(pack.attachments.length, 1);
    assert.equal(pack.attachments[0].id, attachment.id);
    assert.equal(pack.note.attachments?.[0]?.id || pack.attachments[0].id, attachment.id);

    const continued = temporary.knowledge.continueWorkPackage('local', pack.id, { body: '按图再改一版' });
    assert.equal(continued.attachments[0].id, attachment.id);

    const files = temporary.knowledge.resolveAttachmentFiles('local', 'work-package', pack.id);
    assert.equal(files.length, 1);
    assert.equal(files[0].relativePath, `blobs/attachments/${attachment.id}.png`);
    assert.equal(files[0].absolutePath.includes('blobs'), true);
    assert.equal(files[0].absolutePath.includes(':\\') || files[0].absolutePath.startsWith('/'), true);

    const prompt = buildCursorSessionPrompt(pack, { images: files.map((item) => item.relativePath) });
    assert.match(prompt, /blobs\/attachments\//);
    assert.doesNotMatch(prompt, /C:\\Users/);

    let seen = null;
    const handlers = createWorkPackageJobHandlers({
      knowledgeService: temporary.knowledge,
      cursorSessionPort: {
        startSession: async (input) => {
          seen = input;
          temporary.knowledge.completeWorkPackage('local', pack.id, {
            claimedBy: 'cursor-session',
            resultSummary: '已对照附图改完',
            changedPaths: ['apps/web/public/app.js'],
          });
          return { agentId: 'cursor-cli', runId: '0', posted: true };
        },
      },
    });
    await handlers['work-package.dispatch']({ workPackageId: pack.id });
    assert.deepEqual(seen.imagePaths, [files[0].absolutePath]);
    assert.match(seen.prompt, /blobs\/attachments\//);
  } finally {
    temporary.remove();
  }
});

test('HTTP upload and content stay on paired devices and hide host paths', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ai-center-attach-http-'));
  const app = createAiCenterServer({
    host: '127.0.0.1',
    port: 0,
    dataDirectory: directory,
    runtimeDirectory: directory,
    publicUrl: 'https://center.example.com',
  });
  const address = await app.listen();
  const publicHeaders = { Host: 'center.example.com', 'CF-Connecting-IP': '203.0.113.9' };
  try {
    const pairing = await fetch(`${address.localUrl}/api/v1/pairing`).then((response) => response.json());
    const publicCandidate = pairing.candidates.find((candidate) => candidate.scope === 'public');
    const pairToken = new URL(publicCandidate.webPairUrl).searchParams.get('pair');
    const pairResponse = await fetch(`${address.localUrl}/api/v1/pair`, {
      method: 'POST',
      headers: { ...publicHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pairToken, deviceName: '附图测试手机' }),
    });
    const cookie = pairResponse.headers.get('set-cookie').split(';')[0];

    const denied = await fetch(`${address.localUrl}/api/v1/attachments`, {
      method: 'POST',
      headers: { ...publicHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: PNG_1X1.toString('base64') }),
    });
    assert.equal(denied.status, 401);

    const uploaded = await fetch(`${address.localUrl}/api/v1/attachments`, {
      method: 'POST',
      headers: { ...publicHeaders, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        mime: 'image/png',
        originalName: 'phone.png',
        data: PNG_1X1.toString('base64'),
      }),
    }).then((response) => response.json());
    assert.equal(uploaded.ok, true);
    assert.equal(uploaded.attachment.mime, 'image/png');
    assert.equal(JSON.stringify(uploaded).includes(directory), false);
    assert.equal(JSON.stringify(uploaded).includes('blobs/attachments'), false);

    const created = await fetch(`${address.localUrl}/api/v1/work-packages`, {
      method: 'POST',
      headers: { ...publicHeaders, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ body: '按附图改底栏', attachmentIds: [uploaded.attachment.id] }),
    }).then((response) => response.json());
    assert.equal(created.workPackage.attachments[0].id, uploaded.attachment.id);
    assert.match(created.workPackage.attachments[0].url, /\/content$/);

    const file = await fetch(`${address.localUrl}${created.workPackage.attachments[0].url}`, {
      headers: { ...publicHeaders, Cookie: cookie },
    });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.equal(bytes.equals(PNG_1X1), true);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
