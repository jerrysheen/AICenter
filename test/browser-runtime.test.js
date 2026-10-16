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

const NOT_PREPARED = 'request is not prepared or the daemon restarted; prepare a new request before starting';

// Mirrors bsk 0.3.2: `session start --request-id` is rejected until this
// process has seen `session request <id> --prepare`. `restart()` drops that
// memory the way a daemon restart does.
function createEnforcingBsk(respond) {
  const prepared = new Set();
  const ready = new Set();
  const commands = [];
  async function runCommand(args, options) {
    commands.push({ args: [...args], timeoutMs: options?.timeoutMs });
    const body = args[0] === '--json' ? args.slice(1) : args;
    if (body[0] === 'session' && body[1] === 'request' && body.includes('--prepare')) {
      prepared.add(body[2]);
      return {
        code: 0,
        stdout: JSON.stringify({ request_id: body[2], state: 'prepared', session: null }),
        stderr: '',
      };
    }
    if (body[0] === 'session' && body[1] === 'request' && body.includes('--claim')) {
      if (!ready.has(body[2])) {
        return {
          code: 1,
          stdout: JSON.stringify({ code: 'not_found', message: 'start request not found' }),
          stderr: '',
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ request_id: body[2], state: 'active', session: null }),
        stderr: '',
      };
    }
    if (body[0] === 'session' && body[1] === 'request' && body.includes('--cancel')) {
      ready.delete(body[2]);
      return {
        code: 0,
        stdout: JSON.stringify({ request_id: body[2], state: 'closed', session: null }),
        stderr: '',
      };
    }
    if (body[0] === 'session' && body[1] === 'start') {
      const requestId = body[body.indexOf('--request-id') + 1];
      if (!prepared.has(requestId)) {
        return {
          code: 1,
          stdout: JSON.stringify({ code: 'invalid_params', message: NOT_PREPARED }),
          stderr: '',
        };
      }
      const result = await respond(args, options);
      if (result && result.code === 0) ready.add(requestId);
      return result;
    }
    return respond(args, options);
  }
  return {
    commands,
    runCommand,
    restart() {
      prepared.clear();
      ready.clear();
    },
  };
}

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
  const fake = createEnforcingBsk(async (args) => {
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
    if (args[2] === 'start') {
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
  });
  const client = createBrowserSkillClient({ runCommand: fake.runCommand });
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
  const lifecycle = fake.commands.map((item) => item.args.slice(1, 3).join(' '));
  assert.deepEqual(lifecycle, ['status', 'session request', 'session start', 'session request']);
  const prepare = fake.commands[1];
  const start = fake.commands[2];
  const claim = fake.commands[3];
  assert.equal(prepare.args[0], '--json');
  assert.ok(prepare.args.includes('--prepare'));
  assert.ok(start.args.includes('--no-focus'));
  assert.ok(start.args.includes('bilibili.subtitle'));
  assert.equal(start.args[start.args.indexOf('--request-id') + 1], prepare.args[3]);
  assert.ok(claim.args.includes('--claim'));
  assert.equal(claim.args[3], prepare.args[3]);
  assert.equal(commands.some((args) => args.includes('stop') || args.includes('list')), false);
});

test('session start without prepare is rejected', async () => {
  const fake = createEnforcingBsk(async () => ({
    code: 0,
    stdout: JSON.stringify({ session_id: 'WXYZ', browser_instance_id: 'chrome-1' }),
    stderr: '',
  }));
  const requestId = `${Date.now() + 10 * 60 * 1000}:11111111-1111-4111-8111-111111111111`;
  const skipped = await fake.runCommand([
    '--json', 'session', 'start', '--request-id', requestId, '--name', 'x.home', '--no-focus',
  ]);
  assert.equal(skipped.code, 1);
  assert.match(skipped.stdout, /request is not prepared or the daemon restarted/);
  assert.equal(fake.commands.some((item) => item.args.includes('--prepare')), false);

  const client = createBrowserSkillClient({ runCommand: fake.runCommand });
  const session = await client.startSession({ purpose: 'x.home', focused: false });
  assert.equal(session.sessionId, 'WXYZ');
  const prepare = fake.commands.find((item) => item.args.includes('--prepare'));
  const start = fake.commands.find((item, index) => item.args[2] === 'start' && index > fake.commands.indexOf(prepare));
  const preparedId = prepare.args[3];
  assert.equal(start.args[start.args.indexOf('--request-id') + 1], preparedId);
  assert.ok(fake.commands.some((item) => item.args.includes('--claim') && item.args[3] === preparedId));

  fake.restart();
  const afterRestart = await fake.runCommand([
    '--json', 'session', 'start', '--request-id', preparedId, '--name', 'x.home',
  ]);
  assert.equal(afterRestart.code, 1);
  assert.match(afterRestart.stdout, /daemon restarted/);
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
  assert.equal(commands[0].timeoutMs, 50_000);
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

test('a lock held for 80s returns deadline without starting a session', async () => {
  const provider = createRecordingProvider();
  const runtime = createBrowserRuntime({ provider, maxHoldMs: 120_000 });
  const held = runtime.withSession({ purpose: 'hold' }, () => new Promise((resolve) => setTimeout(resolve, 80_000)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const started = Date.now();
  const result = await runtime.withSession({
    purpose: 'queued',
    deadlineAt: Date.now() + 90_000,
  }, async () => 'should-not-run');
  const elapsed = Date.now() - started;
  assert.ok(elapsed <= 76_000, `waiter returned in ${elapsed}ms`);
  assert.ok(elapsed >= 70_000, `waiter returned in ${elapsed}ms`);
  assert.equal(result.error, 'deadline');
  assert.equal(result.reason, 'lock_wait');
  assert.equal(provider.calls.filter((item) => item[0] === 'start').length, 1);
  await held;
});

test('a slow session start reports browser_cold_start', async () => {
  const fake = createEnforcingBsk(async (args, options) => {
    if (args[2] !== 'start') {
      return { code: 0, stdout: JSON.stringify({ sessions: [] }), stderr: '' };
    }
    await new Promise((resolve, reject) => {
      setTimeout(
        () => reject(Object.assign(new Error(`bsk timed out after ${options.timeoutMs}ms`), { killed: true })),
        options.timeoutMs,
      );
    });
  });
  const client = createBrowserSkillClient({ runCommand: fake.runCommand });
  const runtime = createBrowserRuntime({ provider: client });
  const started = Date.now();
  const result = await runtime.withSession({
    purpose: 'slow',
    // The runtime will not open a session with under 20s left. 22s still
    // leaves about 7s for the start itself.
    deadlineAt: Date.now() + 22_000,
  }, async () => 'should-not-run');
  const elapsed = Date.now() - started;
  assert.equal(result.error, 'browser_cold_start');
  assert.equal(result.reason, 'browser_cold_start');
  assert.ok(elapsed < 8_000, `start settled in ${elapsed}ms`);
  assert.ok(elapsed >= 4_000, `start settled in ${elapsed}ms`);
});

test('a startup timeout cancels only that start request', async () => {
  const fake = createEnforcingBsk(async (args) => {
    if (args[2] === 'start') {
      throw Object.assign(new Error('bsk timed out after 20ms'), { killed: true });
    }
    return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
  });
  const client = createBrowserSkillClient({ runCommand: fake.runCommand });
  const started = Date.now();
  await assert.rejects(
    () => client.startSession({ purpose: 'x.home', focused: false, deadlineAt: Date.now() + 20_000 }),
    (error) => error.kind === 'browser_cold_start' && error.message === 'browser_cold_start',
  );
  assert.ok(Date.now() - started < 2_000);
  const prepare = fake.commands.find((item) => item.args.includes('--prepare'));
  const start = fake.commands.find((item) => item.args[2] === 'start');
  const claim = fake.commands.find((item) => item.args.includes('--claim'));
  const cancel = fake.commands.find((item) => item.args.includes('--cancel'));
  const requestId = start.args[start.args.indexOf('--request-id') + 1];
  assert.match(requestId, /^\d+:[0-9a-f-]{36}$/i);
  const expiry = Number(requestId.slice(0, requestId.indexOf(':')));
  assert.ok(expiry >= started + 9 * 60 * 1000 - 1_000);
  assert.ok(expiry <= started + 9 * 60 * 1000 + 5_000, `token expiry is ${expiry - started}ms, expected about 9 minutes`);
  assert.equal(prepare.args[3], requestId);
  assert.ok(fake.commands.indexOf(prepare) < fake.commands.indexOf(start));
  assert.equal(claim, undefined);
  assert.deepEqual(cancel.args.slice(1), ['session', 'request', requestId, '--cancel']);
  assert.ok(cancel.timeoutMs <= 5_000);
  assert.equal(fake.commands.filter((item) => item.args.includes('--cancel')).length, 1);
  assert.equal(fake.commands.some((item) => item.args.includes('list') || item.args[2] === 'stop'), false);
});

test('a non-timeout start error still cancels that request', async () => {
  const commands = [];
  const client = createBrowserSkillClient({
    async runCommand(args, options) {
      commands.push({ args, timeoutMs: options.timeoutMs });
      if (args.includes('--prepare')) {
        return { code: 0, stdout: JSON.stringify({ request_id: args[3], state: 'prepared' }), stderr: '' };
      }
      if (args[2] === 'start') {
        return {
          code: 1,
          stdout: JSON.stringify({ code: 'no_browser_connected', message: 'extension not connected' }),
          stderr: '',
        };
      }
      if (args.includes('--cancel')) {
        return { code: 0, stdout: JSON.stringify({ request_id: args[3], state: 'closed' }), stderr: '' };
      }
      return { code: 1, stdout: JSON.stringify({ message: 'unexpected' }), stderr: '' };
    },
  });
  await assert.rejects(
    () => client.startSession({ purpose: 'x.home', focused: false }),
    (error) => error instanceof BrowserUnavailableError && /extension not connected/.test(error.message),
  );
  const start = commands.find((item) => item.args[2] === 'start');
  const requestId = start.args[start.args.indexOf('--request-id') + 1];
  const cancel = commands.filter((item) => item.args.includes('--cancel'));
  assert.equal(cancel.length, 1);
  assert.equal(cancel[0].args[3], requestId);
  assert.equal(commands.some((item) => item.args.includes('--claim') || item.args[2] === 'stop'), false);
});

test('claim failure cancels the request and stops that session', async () => {
  const commands = [];
  const client = createBrowserSkillClient({
    async runCommand(args, options) {
      commands.push({ args, timeoutMs: options.timeoutMs });
      if (args.includes('--prepare')) {
        return { code: 0, stdout: JSON.stringify({ request_id: args[3], state: 'prepared' }), stderr: '' };
      }
      if (args[2] === 'start') {
        return {
          code: 0,
          stdout: JSON.stringify({ session_id: 'WXYZ', browser_instance_id: 'chrome-1' }),
          stderr: '',
        };
      }
      if (args.includes('--claim')) {
        return {
          code: 1,
          stdout: JSON.stringify({ code: 'cancelled', message: 'start request cannot be claimed' }),
          stderr: '',
        };
      }
      if (args.includes('--cancel')) {
        return { code: 0, stdout: JSON.stringify({ request_id: args[3], state: 'closed' }), stderr: '' };
      }
      if (args[2] === 'stop') throw new Error('stop failed');
      return { code: 1, stdout: JSON.stringify({ message: 'unexpected' }), stderr: '' };
    },
  });
  await assert.rejects(
    () => client.startSession({ purpose: 'x.home' }),
    (error) => error instanceof BrowserCommandError && /cannot be claimed/.test(error.message),
  );
  const claim = commands.find((item) => item.args.includes('--claim'));
  const cancel = commands.find((item) => item.args.includes('--cancel'));
  const stop = commands.find((item) => item.args[2] === 'stop');
  assert.ok(commands.indexOf(claim) < commands.indexOf(cancel));
  assert.ok(commands.indexOf(cancel) < commands.indexOf(stop));
  assert.deepEqual(stop.args.slice(1), ['session', 'stop', 'WXYZ']);
  assert.equal(stop.timeoutMs, 5_000);
  assert.equal(commands.filter((item) => item.args[2] === 'stop').length, 1);
  assert.equal(commands.some((item) => item.args.includes('--name') && item.args[2] === 'stop'), false);
});

test('prepare and claim responses without state fail closed', async () => {
  const missingPrepare = [];
  const prepareClient = createBrowserSkillClient({
    async runCommand(args) {
      missingPrepare.push(args);
      if (args.includes('--prepare')) {
        return { code: 0, stdout: JSON.stringify({ request_id: args[3], session: null }), stderr: '' };
      }
      if (args.includes('--cancel')) {
        return { code: 0, stdout: JSON.stringify({ request_id: args[3], state: 'closed' }), stderr: '' };
      }
      return {
        code: 0,
        stdout: JSON.stringify({ session_id: 'SHOULD-NOT-START', browser_instance_id: 'chrome-1' }),
        stderr: '',
      };
    },
  });
  await assert.rejects(
    () => prepareClient.startSession({ purpose: 'x.home' }),
    (error) => error instanceof BrowserCommandError && /missing/.test(error.message),
  );
  assert.equal(missingPrepare.some((args) => args[2] === 'start'), false);
  assert.equal(missingPrepare.filter((args) => args.includes('--cancel')).length, 1);

  const missingClaim = [];
  const claimClient = createBrowserSkillClient({
    async runCommand(args, options) {
      missingClaim.push({ args, timeoutMs: options.timeoutMs });
      if (args.includes('--prepare')) {
        return { code: 0, stdout: JSON.stringify({ request_id: args[3], state: 'prepared' }), stderr: '' };
      }
      if (args[2] === 'start') {
        return {
          code: 0,
          stdout: JSON.stringify({ session_id: 'SESS', browser_instance_id: 'chrome-1' }),
          stderr: '',
        };
      }
      if (args.includes('--claim')) {
        return { code: 0, stdout: JSON.stringify({ request_id: args[3], session: null }), stderr: '' };
      }
      if (args.includes('--cancel') || args[2] === 'stop') {
        return { code: 0, stdout: JSON.stringify({ ok: true, state: 'closed' }), stderr: '' };
      }
      return { code: 1, stdout: JSON.stringify({ message: 'unexpected' }), stderr: '' };
    },
  });
  await assert.rejects(
    () => claimClient.startSession({ purpose: 'x.home' }),
    (error) => error instanceof BrowserCommandError && /没有进入 active：missing/.test(error.message),
  );
  const claim = missingClaim.find((item) => item.args.includes('--claim'));
  const cancel = missingClaim.find((item) => item.args.includes('--cancel'));
  const stop = missingClaim.find((item) => item.args[2] === 'stop');
  assert.ok(missingClaim.indexOf(claim) < missingClaim.indexOf(cancel));
  assert.ok(missingClaim.indexOf(cancel) < missingClaim.indexOf(stop));
  assert.deepEqual(stop.args.slice(1), ['session', 'stop', 'SESS']);
  assert.equal(stop.timeoutMs, 5_000);
});

test('legacy-cdp provider is no longer accepted', () => {
  assert.throws(
    () => createConfiguredBrowserRuntime({ providerName: 'legacy-cdp', env: { AI_BROWSER_PROVIDER: 'legacy-cdp' } }),
    /只支持 bsk|没有 legacy-cdp/,
  );
});
