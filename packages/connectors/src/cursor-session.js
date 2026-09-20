import { spawn, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workPackageTraceId } from '../../contracts/src/knowledge.js';

export { workPackageTraceId };

const DEFAULT_API_BASE = 'http://127.0.0.1:8787';
const SESSION_ACTOR = 'cursor-session';
const DEFAULT_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_CURSOR_MODEL = 'cursor-grok-4.6-high-fast';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function cursorSessionActor() {
  return SESSION_ACTOR;
}

export function buildCursorSessionPrompt(pack, {
  apiBase = DEFAULT_API_BASE,
  trace,
  images = [],
} = {}) {
  const id = text(pack?.id);
  const body = text(pack?.body || pack?.note?.body);
  const title = text(pack?.title);
  const hashId = text(trace?.hashId) || workPackageTraceId(id);
  const relativeDir = text(trace?.relativeDir) || `.ai-data/logs/work-packages/${hashId}`;
  return [
    '你是 AI Center 用本机 Cursor CLI 拉起的一次性任务进程，做完就退出。',
    '只做这一条。做完必须自己上报，不要等人，也不要领取其他工作包。',
    '',
    `工作包 ID: ${id}`,
    `步骤目录 hashId: ${hashId}`,
    `步骤目录: ${relativeDir}`,
    title ? `标题: ${title}` : '',
    pack?.parentWorkPackageId
      ? '上一轮是一次性 session，不能 resume。正文里的上一目标 / 上一进展 / 上一步骤是上一轮全过程，必须接着做，不要只问上一句对话。'
      : '',
    '正文:',
    body || '（无正文）',
    ...(Array.isArray(images) && images.length
      ? [
        '',
        '附图（已通过 --image 交给本机 Cursor CLI，也可按仓库相对路径读取）:',
        ...images.map((item) => `- ${item}`),
      ]
      : []),
    '',
    '遵守仓库 AGENTS.md 与 docs/ai-development-guide.md。走 Contract → Service → Repository。',
    `做之前先读 ${relativeDir}/prompt.txt。每完成一步，向 ${relativeDir}/steps.jsonl 追加一行 JSON，不要改已有行。`,
    '追加必须用 UTF-8 无 BOM。Windows 不要用 Add-Content、Out-File、Set-Content 或 >>，否则中文会写成 GBK，步骤拆解乱码。',
    '用 node -e "require(\'fs\').appendFileSync(file, line+\'\\n\', \'utf8\')"，或 [IO.File]::AppendAllText(file, line+[char]10, [Text.UTF8Encoding]::new($false))。摘要也可用 \\uXXXX。',
    '{"at":毫秒时间戳,"step":"plan|read|edit|test|report","status":"started|done|failed","summary":"一句话","paths":["改过的路径"]}',
    '第一步先写 plan。卡住或失败也要追加一行。',
    `完成：POST ${apiBase}/api/v1/work-packages/${id}/complete`,
    `{"claimedBy":"${SESSION_ACTOR}","resultSummary":"一句话结果","changedPaths":["改过的路径"]}`,
    `失败：POST ${apiBase}/api/v1/work-packages/${id}/fail`,
    `{"claimedBy":"${SESSION_ACTOR}","resultSummary":"原因"}`,
    'changedPaths 必须如实列出。apps/web/public、docs、test 立刻生效，不要重启进程。',
    '改了 apps/web/src、apps/worker、packages 时，只上报路径；CLI 退出后由本机启动器弹 Web/Worker，隧道保持。',
    '不要自己杀进程，不要跑 restart 脚本，不要另开公网端口。未要求不要 commit。',
  ].filter((line) => line !== '').join('\n');
}

export function resolveCursorAgentModel(env = process.env) {
  return text(env.AI_CENTER_CURSOR_MODEL) || DEFAULT_CURSOR_MODEL;
}

export function buildCursorAgentArgs({ workspace, prompt, model, imagePaths = [] } = {}) {
  const chosen = text(model) || DEFAULT_CURSOR_MODEL;
  const images = (Array.isArray(imagePaths) ? imagePaths : []).map(text).filter(Boolean);
  return [
    '-p',
    '--force',
    '--trust',
    '--workspace',
    text(workspace),
    '--model',
    chosen,
    '--output-format',
    'text',
    ...images.flatMap((item) => ['--image', item]),
    text(prompt),
  ];
}

function knownWindowsAgentCmd(env = process.env) {
  const root = text(env.LOCALAPPDATA);
  if (!root) return '';
  const candidate = path.join(root, 'cursor-agent', 'agent.cmd');
  return existsSync(candidate) ? candidate : '';
}

function usableAgentBin(file) {
  const found = text(file);
  if (!found) return '';
  if (/\.ps1$/i.test(found)) return '';
  return found;
}

function windowsPowershell(env = process.env) {
  const root = text(env.SystemRoot) || text(env.SYSTEMROOT) || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function resolveCursorAgentLaunch({ env = process.env, lookup } = {}) {
  const command = resolveCursorAgentBin({ env, lookup });
  if (process.platform === 'win32' && /\.cmd$/i.test(command)) {
    const script = path.join(path.dirname(command), 'cursor-agent.ps1');
    if (existsSync(script)) {
      return {
        command: windowsPowershell(env),
        args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      };
    }
    return {
      command: text(env.ComSpec) || 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    };
  }
  return { command, args: [] };
}

export function resolveCursorAgentBin({ env = process.env, lookup } = {}) {
  const explicit = text(env.AI_CENTER_CURSOR_AGENT);
  if (explicit) return explicit;
  const known = knownWindowsAgentCmd(env);
  if (known) return known;
  const names = process.platform === 'win32'
    ? ['agent.cmd', 'agent.exe', 'cursor-agent.cmd', 'cursor-agent.exe']
    : ['agent', 'cursor-agent'];
  const search = typeof lookup === 'function'
    ? lookup
    : (name) => {
      const command = process.platform === 'win32' ? 'where.exe' : 'which';
      return execFileSync(command, [name], { encoding: 'utf8' })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
    };
  for (const name of names) {
    try {
      const found = usableAgentBin(search(name));
      if (found) return found;
    } catch {
      // try next name
    }
  }
  throw new Error(
    '本机没有 Cursor CLI（agent.cmd）。Windows 先安装：irm \'https://cursor.com/install?win32=true\' | iex，再跑：agent.cmd login',
  );
}

export function writeCursorAgentPromptFile(prompt, { now = Date.now() } = {}) {
  const file = path.join(os.tmpdir(), `ai-center-cli-${now}.txt`);
  writeFileSync(file, String(prompt || ''), 'utf8');
  return file;
}

export function resolveVisibleCursorAgentLaunch({
  workspace,
  promptFile,
  model,
  imagePaths = [],
  env = process.env,
  lookup,
  wrapper,
} = {}) {
  const launch = resolveCursorAgentLaunch({ env, lookup });
  const agentScript = launch.args.includes('-File')
    ? launch.args[launch.args.indexOf('-File') + 1]
    : launch.command;
  const windowScript = text(wrapper) || path.join(text(workspace) || process.cwd(), 'scripts', 'run-cursor-cli-window.ps1');
  if (!existsSync(windowScript)) {
    throw new Error('缺少 scripts/run-cursor-cli-window.ps1，无法弹出可见任务窗口');
  }
  return {
    command: text(env.ComSpec) || 'cmd.exe',
    args: [
      '/d',
      '/c',
      'start',
      '/wait',
      windowsPowershell(env),
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      windowScript,
      '-AgentScript',
      agentScript,
      '-Workspace',
      text(workspace),
      '-PromptFile',
      text(promptFile),
      '-Model',
      text(model) || resolveCursorAgentModel(env),
      ...(Array.isArray(imagePaths) ? imagePaths : []).flatMap((item) => {
        const image = text(item);
        return image ? ['-Image', image] : [];
      }),
    ],
  };
}

export function createCursorAgentSpawnOptions({ cwd, env = process.env } = {}) {
  return {
    cwd,
    env: { ...env },
    shell: false,
    windowsHide: true,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}

export function runCursorAgentProcess({
  command,
  args,
  cwd,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnProcess = spawn,
  signal,
} = {}) {
  if (!command) throw new Error('Cursor CLI command is required');
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, createCursorAgentSpawnOptions({ cwd, env }));
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => {
      child.kill();
      finish(() => reject(new Error('Cursor CLI 被取消')));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`Cursor CLI 超过 ${timeoutMs}ms 未结束`)));
    }, Math.max(5_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    signal?.addEventListener('abort', abort, { once: true });
    child.once?.('error', (error) => finish(() => reject(new Error(`无法启动 Cursor CLI：${error.message}`))));
    child.stdout?.on('data', (chunk) => {
      if (Buffer.concat(stdout).length < 256 * 1024) stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk);
    });
    const onClose = (code) => finish(() => resolve({
      code: Number(code || 0),
      stdout: Buffer.concat(stdout).toString('utf8').trim(),
      stderr: Buffer.concat(stderr).toString('utf8').trim(),
    }));
    if (typeof child.once === 'function') child.once('close', onClose);
    else onClose(0);
  });
}

export function createCursorSessionPort({
  workspace,
  apiBase = process.env.AI_CENTER_LOCAL_URL || DEFAULT_API_BASE,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  lookup,
  runProcess = runCursorAgentProcess,
  startSession,
} = {}) {
  return Object.freeze({
    async startSession(input = {}) {
      if (typeof startSession === 'function') {
        return startSession(input);
      }
      const prompt = input.prompt || buildCursorSessionPrompt(input.workPackage, { apiBase });
      const cwd = text(workspace) || process.cwd();
      const hidden = String(env.AI_CENTER_CURSOR_CLI_HIDDEN || '').trim() === '1';
      const imagePaths = Array.isArray(input.imagePaths) ? input.imagePaths : [];
      let launch;
      if (process.platform === 'win32' && !hidden) {
        launch = resolveVisibleCursorAgentLaunch({
          workspace: cwd,
          promptFile: writeCursorAgentPromptFile(prompt),
          model: resolveCursorAgentModel(env),
          imagePaths,
          env,
          lookup,
        });
      } else {
        launch = resolveCursorAgentLaunch({ env, lookup });
        launch = {
          command: launch.command,
          args: [...launch.args, ...buildCursorAgentArgs({
            workspace: cwd,
            prompt,
            model: resolveCursorAgentModel(env),
            imagePaths,
          })],
        };
      }
      const result = await runProcess({
        command: launch.command,
        args: launch.args,
        cwd,
        env,
        timeoutMs,
        signal: input.signal,
      });
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || `Cursor CLI 退出码 ${result.code}`);
      }
      return {
        agentId: 'cursor-cli',
        runId: String(result.code),
        posted: true,
        stdout: result.stdout,
      };
    },
  });
}
