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
import { runBrowserProcess } from '../packages/connectors/src/browser/browserskill-client.js';

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

test('BrowserSkill navigate passes a timeout and optional wait condition', async () => {
  const commands = [];
  const client = createBrowserSkillClient({
    timeoutMs: 60_000,
    async runCommand(args, options) {
      commands.push({ args, timeoutMs: options.timeoutMs });
      return { code: 0, stdout: JSON.stringify({ ok: true, final_url: args[2] }), stderr: '' };
    },
  });
  await client.navigate('SESS', 'https://x.com/home', { timeoutMs: 45_000, waitUntil: 'domcontentloaded' });
  assert.ok(commands[0].args.includes('--timeout'));
  assert.ok(commands[0].args.includes('45000ms'));
  assert.ok(commands[0].args.includes('--wait-until'));
  assert.ok(commands[0].args.includes('domcontentloaded'));
  // The shared wall-clock budget may already have spent a few milliseconds
  // before spawning the first command, but must leave navigation's IPC margin.
  assert.ok(commands[0].timeoutMs > 45_000 && commands[0].timeoutMs <= 65_000);
});

test('browser process abort settles without waiting for close', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = runBrowserProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 30_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(pending, (error) => error.name === 'AbortError' && error.code === 'ABORT_ERR');
  assert.ok(Date.now() - started < 2_000);
});

test('browser process timeout settles without waiting for close', async () => {
  const started = Date.now();
  await assert.rejects(
    () => runBrowserProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 }),
    (error) => error.killed === true,
  );
  assert.ok(Date.now() - started < 2_000);
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

test('BrowserSkill refreshes cooperate context when a shared action is refused', async () => {
  const commands = [];
  let evaluates = 0;
  let lastContext = '';
  const client = createBrowserSkillClient({
    async runCommand(args) {
      commands.push(args.slice(1, 4).join(' '));
      const contextIndex = args.indexOf('--context');
      if (contextIndex >= 0) lastContext = args[contextIndex + 1];
      if (args[1] === 'evaluate') {
        evaluates += 1;
        if (evaluates < 3) {
          return {
            code: 1,
            stdout: JSON.stringify({
              code: 'permission_denied',
              message: evaluates === 1
                ? 'This action requires the context returned by the latest cooperate sync'
                : 'The action\'s observed content changed; synchronize and replan',
            }),
            stderr: '',
          };
        }
        return { code: 0, stdout: JSON.stringify({ ok: true, value: { status: 200, text: '{}' } }), stderr: '' };
      }
      if (args[1] === 'cooperate' && args[2] === 'sync') {
        return {
          code: 0,
          stdout: JSON.stringify({ context_id: evaluates === 1 ? 'ctx-a' : 'ctx-b' }),
          stderr: '',
        };
      }
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
    },
  });
  assert.deepEqual(await client.evaluate('SESS', '1+1'), { status: 200, text: '{}' });
  assert.deepEqual(commands, [
    'evaluate 1+1 --session',
    'cooperate sync --session',
    'evaluate 1+1 --session',
    'cooperate wait --session',
    'cooperate sync --session',
    'evaluate 1+1 --session',
  ]);
  assert.equal(lastContext, 'ctx-b');
});

test('BrowserSkill keeps waiting while a live page is still moving', async () => {
  const commands = [];
  let evaluates = 0;
  const client = createBrowserSkillClient({
    async runCommand(args) {
      commands.push(args.slice(1, 4).join(' '));
      if (args[1] === 'evaluate') {
        evaluates += 1;
        if (evaluates < 4) {
          return {
            code: 1,
            stdout: JSON.stringify({
              code: 'permission_denied',
              message: 'The action\'s observed content changed; synchronize and replan',
            }),
            stderr: '',
          };
        }
        return { code: 0, stdout: JSON.stringify({ ok: true, value: { tweets: 1 } }), stderr: '' };
      }
      if (args[1] === 'cooperate' && args[2] === 'sync') {
        return { code: 0, stdout: JSON.stringify({ context_id: `ctx-${evaluates}` }), stderr: '' };
      }
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
    },
  });
  assert.deepEqual(await client.evaluate('SESS', 'read()'), { tweets: 1 });
  assert.deepEqual(commands, [
    'evaluate read() --session',
    'cooperate wait --session',
    'cooperate sync --session',
    'evaluate read() --session',
    'cooperate wait --session',
    'cooperate sync --session',
    'evaluate read() --session',
    'cooperate wait --session',
    'cooperate sync --session',
    'evaluate read() --session',
  ]);
});

test('BrowserSkill stops after one resync when the caller will not wait out a moving page', async () => {
  const commands = [];
  const client = createBrowserSkillClient({
    async runCommand(args) {
      commands.push(args.slice(1, 4).join(' '));
      if (args[1] === 'evaluate') {
        return {
          code: 1,
          stdout: JSON.stringify({
            code: 'permission_denied',
            message: 'The action\'s observed content changed; synchronize and replan',
          }),
          stderr: '',
        };
      }
      if (args[1] === 'cooperate' && args[2] === 'sync') {
        return { code: 0, stdout: JSON.stringify({ context_id: 'ctx-once' }), stderr: '' };
      }
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
    },
  });
  await assert.rejects(
    () => client.evaluate('SESS', 'read()', { moving: 'once' }),
    /observed content changed/,
  );
  assert.deepEqual(commands, [
    'evaluate read() --session',
    'cooperate sync --session',
    'evaluate read() --session',
  ]);
});

test('BrowserSkill media refusal refreshes context without waiting in once mode', async () => {
  const commands = [];
  const client = createBrowserSkillClient({ async runCommand(args) {
    commands.push(args[1]);
    if (args[1] === 'cooperate') return { code: 0, stdout: '{"context_id":"fresh"}' };
    if (!args.includes('--context')) return { code: 1, stdout: JSON.stringify({ code: 'permission_denied', message: 'The media source changed; synchronize and replan' }) };
    return { code: 0, stdout: '{"value":42}' };
  } });
  assert.equal(await client.evaluate('SESS', 'read()', { moving: 'once' }), 42);
  assert.deepEqual(commands, ['evaluate', 'cooperate', 'evaluate']);
});

test('BrowserSkill total deadline aborts a stuck resync and allows the next command', async () => {
  let stuck = true;
  const client = createBrowserSkillClient({ async runCommand(args, options) {
    if (!stuck) return { code: 0, stdout: '{"value":7}' };
    if (args[1] === 'evaluate') return { code: 1, stdout: JSON.stringify({ message: 'The media source changed; synchronize and replan' }) };
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true }));
  } });
  const start = Date.now();
  await assert.rejects(client.evaluate('SESS', 'read()', { timeoutMs: 1000, moving: 'once' }), /bsk timed out/);
  assert.ok(Date.now() - start < 3000);
  stuck = false;
  assert.equal(await client.evaluate('SESS', 'read()'), 7);
});

test('BrowserSkill narrows the cooperate guard and drops a missing selector once', async () => {
  const commands = [];
  let evaluates = 0;
  const client = createBrowserSkillClient({
    async runCommand(args) {
      commands.push(args.filter((item) => item !== '--json'));
      if (args[1] === 'evaluate') {
        evaluates += 1;
        if (evaluates === 1) {
          return {
            code: 1,
            stdout: JSON.stringify({ code: 'selector_not_found', message: 'selector did not match any element' }),
            stderr: '',
          };
        }
        return { code: 0, stdout: JSON.stringify({ ok: true, value: { logged_in: false } }), stderr: '' };
      }
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
    },
  });
  assert.deepEqual(
    await client.evaluate('SESS', 'inspect()', { dependsOn: ['[data-testid="AppTabBar_Home_Link"]'] }),
    { logged_in: false },
  );
  assert.equal(commands[0].filter((item) => item === '--depends-on').length, 1);
  assert.ok(commands[0].includes('[data-testid="AppTabBar_Home_Link"]'));
  assert.equal(commands[1].includes('--depends-on'), false);
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

test('session lock releases queued work after the hold limit', async () => {
  const warnings = [];
  const provider = createRecordingProvider();
  const runtime = createBrowserRuntime({
    provider,
    maxHoldMs: 40,
    logger: { warn(line) { warnings.push(line); } },
  });
  const first = runtime.withSession({ purpose: 'stuck' }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return 'first';
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const secondDone = await Promise.race([
    runtime.withSession({ purpose: 'next' }, async () => 'second'),
    new Promise((resolve) => setTimeout(() => resolve('stuck'), 90)),
  ]);
  assert.equal(secondDone, 'second');
  assert.match(warnings.join('\n'), /已放行排队任务/);
  assert.equal(await first, 'first');
});

test('withSession runs one browser callback at a time', async () => {
  const provider = createRecordingProvider();
  const runtime = createBrowserRuntime({ provider });
  let active = 0;
  let peak = 0;
  const hold = () => runtime.withSession({ purpose: 'shared-page' }, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return peak;
  });
  const peaks = await Promise.all([hold(), hold(), hold()]);
  assert.equal(Math.max(...peaks), 1);
  assert.equal(provider.calls.filter((item) => item[0] === 'start').length, 3);
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

test('stop failure does not discard a successful harvest', async () => {
  const warnings = [];
  const provider = createRecordingProvider({
    async stop() {
      throw new Error('No window with id: 699805515');
    },
  });
  const runtime = createBrowserRuntime({
    provider,
    logger: { warn(message) { warnings.push(message); } },
  });
  const value = await runtime.withSession({}, async () => 'harvested');
  assert.equal(value, 'harvested');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /session stop failed/);
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
