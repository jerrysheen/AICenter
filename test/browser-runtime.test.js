import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserCommandError,
  BrowserUnavailableError,
  createBrowserRuntime,
  createBrowserSkillClient,
  createConfiguredBrowserRuntime,
  fetchBilibiliAiSubtitle,
  resolveDefaultBskPath,
} from '../packages/connectors/src/index.js';

function createRecordingProvider(options = {}) {
  const calls = [];
  const provider = {
    id: options.id || 'fake',
    calls,
    async health() {
      return { available: true, daemonConnected: true, browserConnected: true, browsers: 1 };
    },
    async startSession(sessionOptions) {
      calls.push(['start', sessionOptions]);
      if (options.startError) throw options.startError;
      return { sessionId: options.sessionId || 'ABCD', browserId: 'chrome-1' };
    },
    async navigate(sessionId, url) {
      calls.push(['navigate', sessionId, url]);
    },
    async evaluate(sessionId, expression) {
      calls.push(['evaluate', sessionId, Boolean(expression)]);
      if (typeof options.evaluate === 'function') return options.evaluate(expression);
      return { status: 200, url: 'https://example.test', text: '{"ok":true}' };
    },
    async click(sessionId, selector) {
      calls.push(['click', sessionId, selector]);
    },
    async fill(sessionId, selector, value) {
      calls.push(['fill', sessionId, selector, value]);
    },
    async stopSession(sessionId) {
      calls.push(['stop', sessionId]);
      if (typeof options.stop === 'function') return options.stop(sessionId);
    },
  };
  return provider;
}

test('bundled externaltools/bsk.exe is the default CLI path', () => {
  assert.match(
    resolveDefaultBskPath({ env: {}, existsSync: () => true, repositoryRoot: 'F:\\AI-Center' }).replaceAll('\\', '/'),
    /externaltools\/bsk\.exe$/,
  );
  assert.equal(resolveDefaultBskPath({ env: { AI_BSK_PATH: 'C:\\custom\\bsk.exe' } }), 'C:\\custom\\bsk.exe');
  assert.equal(resolveDefaultBskPath({ env: {}, existsSync: () => false }), 'bsk');
});

test('BrowserSkillClient parses JSON session start and status', async () => {
  const commands = [];
  const client = createBrowserSkillClient({
    async runCommand(args) {
      commands.push(args);
      if (args.includes('status')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            daemon_version: '0.1.0',
            browsers: [{ instance_id: 'chrome-1' }],
            sessions: [],
          }),
          stderr: '',
        };
      }
      if (args.includes('start')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            session_id: 'WXYZ',
            browser_instance_id: 'chrome-1',
          }),
          stderr: '',
        };
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
  });
  assert.deepEqual(await client.health(), {
    available: true,
    daemonConnected: true,
    browserConnected: true,
    browsers: 1,
  });
  assert.deepEqual(await client.startSession({ purpose: 'bilibili.subtitle', focused: false }), {
    sessionId: 'WXYZ',
    browserId: 'chrome-1',
  });
  assert.equal(commands[0][0], '--json');
  assert.deepEqual(commands[1].slice(0, 3), ['--json', 'session', 'start']);
  assert.ok(commands[1].includes('--no-focus'));
  assert.ok(commands[1].includes('bilibili.subtitle'));
});

test('BrowserSkillClient click and fill use selector flags', async () => {
  const commands = [];
  const client = createBrowserSkillClient({
    async runCommand(args) {
      commands.push(args);
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
    },
  });
  await client.click('SESS', '.send-btn-wrapper button');
  await client.fill('SESS', '.tiptap.ProseMirror', 'hello');
  assert.deepEqual(commands[0].slice(0, 6), ['--json', 'click', '--session', 'SESS', '--selector', '.send-btn-wrapper button']);
  assert.ok(commands[1].includes('fill'));
  assert.ok(commands[1].includes('--value'));
});

test('BrowserSkillClient normalizes non-JSON and command failures', async () => {
  const invalid = createBrowserSkillClient({
    async runCommand() {
      return { code: 0, stdout: 'not-json', stderr: '' };
    },
  });
  await assert.rejects(() => invalid.startSession(), /没有返回合法 JSON/);

  const failed = createBrowserSkillClient({
    async runCommand() {
      return {
        code: 1,
        stdout: JSON.stringify({
          code: 'no_browser_connected',
          message: 'extension not connected',
        }),
        stderr: '',
      };
    },
  });
  await assert.rejects(() => failed.startSession(), BrowserUnavailableError);
});

test('withSession stops after success', async () => {
  const provider = createRecordingProvider();
  const runtime = createBrowserRuntime({ provider });
  const value = await runtime.withSession({ purpose: 'test' }, async (session) => {
    await session.navigate('https://www.bilibili.com');
    return session.sessionId;
  });
  assert.equal(value, 'ABCD');
  assert.deepEqual(provider.calls.map((item) => item[0]), ['start', 'navigate', 'stop']);
});

test('configured BrowserRuntime supplies the instance browser id by default', async () => {
  const provider = createRecordingProvider();
  const runtime = createConfiguredBrowserRuntime({
    provider,
    env: { AI_CENTER_BROWSER_ID: 'chrome-instance-a' },
  });
  await runtime.withSession({ purpose: 'test' }, async () => {});
  assert.deepEqual(provider.calls[0], ['start', {
    purpose: 'test',
    browserId: 'chrome-instance-a',
  }]);
});

test('caller browser id overrides the configured instance default', async () => {
  const provider = createRecordingProvider();
  const runtime = createBrowserRuntime({ provider, defaultBrowserId: 'chrome-instance-a' });
  await runtime.withSession({ purpose: 'test', browserId: 'chrome-explicit' }, async () => {});
  assert.deepEqual(provider.calls[0], ['start', {
    purpose: 'test',
    browserId: 'chrome-explicit',
  }]);
});

test('withSession still stops when callback throws', async () => {
  const provider = createRecordingProvider();
  const runtime = createBrowserRuntime({ provider });
  await assert.rejects(
    () => runtime.withSession({}, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual(provider.calls.map((item) => item[0]), ['start', 'stop']);
});

test('stop failure does not overlay the original callback error', async () => {
  const warnings = [];
  const provider = createRecordingProvider({
    async stop() {
      throw new Error('stop exploded');
    },
  });
  const runtime = createBrowserRuntime({
    provider,
    logger: { warn(message) { warnings.push(message); } },
  });
  await assert.rejects(
    () => runtime.withSession({}, async () => {
      throw new Error('business failed');
    }),
    /business failed/,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /session stop failed/);
});

test('bilibili ai-zh flow works with a fake BrowserRuntime', async () => {
  const events = [];
  const runtime = {
    async withSession(options, callback) {
      events.push(['start', options.purpose]);
      try {
        return await callback({
          async navigate(url) { events.push(['navigate', url]); },
          async fetchJson(url) {
            events.push(['fetchJson', url.includes('/x/player/') ? 'player' : 'other']);
            if (url.includes('/x/player/')) {
              return {
                status: 200,
                url,
                text: JSON.stringify({
                  code: 0,
                  data: {
                    subtitle: {
                      subtitles: [
                        { lan: 'zh', subtitle_url: 'https://example/zh.json' },
                        { lan: 'ai-zh', subtitle_url: 'https://example/ai.json' },
                      ],
                    },
                  },
                }),
              };
            }
            throw new Error('unexpected browser fetch');
          },
        });
      } finally {
        events.push(['stop']);
      }
    },
  };
  const result = await fetchBilibiliAiSubtitle('BV1cwtN6sEDr', {
    browserRuntime: runtime,
    getJson: async (url) => {
      if (String(url).includes('/x/web-interface/view')) {
        return { code: 0, data: { title: '研读专利', cid: 1, pubdate: 1, owner: { name: '结构笔记' } } };
      }
      return { body: [{ content: 'AI字幕一句' }, { content: 'AI字幕二句' }] };
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.fullText, 'AI字幕一句 AI字幕二句');
  assert.deepEqual(events.map((item) => item[0]), ['start', 'navigate', 'fetchJson', 'stop']);
});

test('bsk provider is selected for bilibili fetchJson', async () => {
  const bsk = createRecordingProvider({
    id: 'bsk',
    evaluate() {
      return {
        status: 200,
        url: 'https://api.bilibili.com/player',
        text: JSON.stringify({
          code: 0,
          data: { subtitle: { subtitles: [{ lan: 'ai-zh', subtitle_url: 'https://example/ai.json' }] } },
        }),
      };
    },
  });
  const runtime = createConfiguredBrowserRuntime({
    providerName: 'bsk',
    providers: { bsk },
  });
  const result = await fetchBilibiliAiSubtitle('BV1cwtN6sEDr', {
    browserRuntime: runtime,
    getJson: async (url) => {
      if (String(url).includes('/x/web-interface/view')) {
        return { code: 0, data: { title: '研读专利', cid: 1, pubdate: 1, owner: { name: '结构笔记' } } };
      }
      return { body: [{ content: '正文' }] };
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(bsk.calls[0][0], 'start');
  assert.equal(bsk.calls.at(-1)[0], 'stop');
});

test('legacy-cdp provider is no longer accepted', () => {
  assert.throws(
    () => createConfiguredBrowserRuntime({ providerName: 'legacy-cdp', env: { AI_BROWSER_PROVIDER: 'legacy-cdp' } }),
    /只支持 bsk|没有 legacy-cdp/,
  );
});
