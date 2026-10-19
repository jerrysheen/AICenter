import { spawn } from 'node:child_process';
import { mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { describeAudioTranscription } from '../../domain/src/audio-transcription.js';
import { readChannelId } from '../../domain/src/youtube-podcasts.js';

const SUB_LANGS = 'zh-Hans,zh-Hant,zh-CN,zh,en,ja';

export function youtubeBlockReason(text) {
  const body = String(text || '');
  if (/confirm you(?:'|’)re not a bot|sign in to confirm|not a bot/i.test(body)) return 'bot-check';
  if (/\b429\b|too many requests/i.test(body)) return '429';
  return '';
}

export function ytDlpBinary(env = process.env) {
  return String(env.AI_CENTER_YT_DLP || 'yt-dlp').trim() || 'yt-dlp';
}

export function cookieArgs(env = process.env) {
  const file = String(env.AI_CENTER_YOUTUBE_COOKIES || '').trim();
  return file ? ['--cookies', file] : [];
}

export function runProcess(command, args, { timeoutMs = 180_000, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, windowsHide: true });
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: error.message, missing: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        code: 127,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        missing: error.code === 'ENOENT',
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, missing: false });
    });
  });
}

export function readYtDlpJson(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function vttToTranscript(vtt) {
  const cues = [];
  const lines = String(vtt || '').replace(/\r\n/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const timing = lines[index].match(/(\d{2}:\d{2}:\d{2})[.,]\d+\s+-->/);
    if (!timing) continue;
    const text = [];
    for (index += 1; index < lines.length && lines[index].trim(); index += 1) {
      text.push(lines[index].replace(/<[^>]+>/g, '').trim());
    }
    const joined = text.join(' ').replace(/\s+/g, ' ').trim();
    if (!joined) continue;
    const previous = cues.at(-1);
    if (previous && (previous.text === joined || joined.startsWith(previous.text))) {
      previous.text = joined;
      continue;
    }
    if (previous && previous.text.startsWith(joined)) continue;
    cues.push({ time: timing[1], text: joined });
  }
  return cues.map((cue) => `[${cue.time}] ${cue.text}`).join('\n');
}

function languageOf(fileName) {
  const match = String(fileName || '').match(/\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)(?:\.auto)?\.vtt$/i);
  return match ? match[1] : '';
}

function sameLanguage(left, right) {
  const a = String(left || '').toLowerCase();
  const b = String(right || '').toLowerCase();
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`) || a.slice(0, 2) === b.slice(0, 2);
}

export function chooseSubtitle(files, info = {}) {
  const original = String(info.language || info.language_code || '').trim();
  const manualLangs = new Set(Object.keys(info.subtitles || {}));
  const autoLangs = new Set(Object.keys(info.automatic_captions || {}));
  const rows = files.map((file) => {
    const lang = languageOf(file.name);
    const autoName = /\.auto\.vtt$/i.test(file.name);
    const manual = manualLangs.has(lang) || (!autoName && !autoLangs.has(lang));
    const auto = autoName || (autoLangs.has(lang) && !manualLangs.has(lang));
    return { ...file, lang, manual: manual && !autoName, auto: auto || autoName };
  }).filter((file) => file.text);
  const manualOriginal = rows.find((file) => file.manual && sameLanguage(file.lang, original));
  if (manualOriginal) return { text: manualOriginal.text, source: 'subtitle-manual' };
  const manual = rows.find((file) => file.manual);
  if (manual) return { text: manual.text, source: 'subtitle-manual' };
  const autoOriginal = rows.find((file) => file.auto && original && sameLanguage(file.lang, original));
  if (autoOriginal) return { text: autoOriginal.text, source: 'subtitle-auto' };
  return { text: '', source: '' };
}

async function readVttFiles(directory) {
  let names = [];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (!name.endsWith('.vtt')) continue;
    const text = vttToTranscript(await readFile(path.join(directory, name), 'utf8'));
    if (text) files.push({ name, text });
  }
  return files;
}

function blockedResult(result) {
  const reason = youtubeBlockReason(`${result.stderr}\n${result.stdout}`);
  if (reason) return { blocked: reason, detail: String(result.stderr || result.stdout || '').slice(0, 300) };
  if (result.missing) return { blocked: 'yt-dlp-missing', detail: '没有找到 yt-dlp' };
  return null;
}

export async function probeYoutubeEpisode({
  videoId,
  url,
  workDir,
  env = process.env,
  run = runProcess,
  timeoutMs = 180_000,
}) {
  await mkdir(workDir, { recursive: true });
  const args = [
    '--skip-download',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs', SUB_LANGS,
    '--convert-subs', 'vtt',
    '--dump-single-json',
    '--no-warnings',
    '--no-playlist',
    ...cookieArgs(env),
    '-o', path.join(workDir, `${videoId}.%(ext)s`),
    url,
  ];
  const result = await run(ytDlpBinary(env), args, { timeoutMs, cwd: workDir });
  const blocked = blockedResult(result);
  if (blocked) return blocked;
  const info = readYtDlpJson(result.stdout) || {};
  if (result.code !== 0 && !info.id) {
    return { failed: true, detail: String(result.stderr || result.stdout || `yt-dlp ${result.code}`).slice(0, 300) };
  }
  const files = await readVttFiles(workDir);
  const subtitle = chooseSubtitle(files, info);
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
  return {
    videoId: info.id || videoId,
    title: info.title || '',
    durationSec: Number(info.duration) || 0,
    liveStatus: info.live_status || '',
    language: info.language || '',
    transcript: subtitle.text,
    transcriptSource: subtitle.source,
  };
}

export async function resolveYoutubeChannelId({ handle, fetchImpl = fetch, env = process.env }) {
  const name = String(handle || '').replace(/^@/, '');
  const response = await fetchImpl(`https://www.youtube.com/@${encodeURIComponent(name)}`, {
    headers: {
      'user-agent': 'AICenter/0.2 youtube-podcasts',
      accept: 'text/html',
      ...(env.AI_CENTER_YOUTUBE_COOKIES ? {} : {}),
    },
  });
  const html = await response.text();
  const blocked = youtubeBlockReason(html) || (response.status === 429 ? '429' : '');
  if (blocked) return { blocked, detail: `频道页 ${response.status || blocked}` };
  if (!response.ok) return { failed: true, detail: `频道页 ${response.status}` };
  const channelId = readChannelId(html);
  if (!channelId) return { failed: true, detail: `没有解析到 @${name} 的频道编号` };
  return { channelId };
}

export async function finishAudioFile(file, work) {
  try {
    return await work(file);
  } finally {
    await rm(file, { force: true }).catch(() => {});
  }
}

export async function transcribeYoutubeAudio({
  videoId,
  url,
  dataDirectory,
  env = process.env,
  quotaRepository,
  languageCodes = [],
  execute,
  run = runProcess,
  workspaceId = 'local',
}) {
  const dir = path.join(dataDirectory, 'tmp', 'youtube-podcasts');
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${videoId}.wav`);
  return finishAudioFile(target, async () => {
    const args = [
      '-f', 'bestaudio',
      '-x',
      '--audio-format', 'wav',
      '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000',
      '--no-playlist',
      '--no-warnings',
      ...cookieArgs(env),
      '-o', target,
      url,
    ];
    const result = await run(ytDlpBinary(env), args, { cwd: dir, timeoutMs: 15 * 60_000 });
    const blocked = blockedResult(result);
    if (blocked) {
      const error = new Error(blocked.detail || blocked.blocked);
      error.code = 'youtube-round-stop';
      error.reason = blocked.blocked;
      throw error;
    }
    if (result.code !== 0) throw new Error(String(result.stderr || '音频下载失败').slice(0, 300));
    const durationMs = await wavFileDurationMs(target) || 60_000;
    const plan = describeAudioTranscription(env, durationMs);
    const relative = path.relative(dataDirectory, target).split(path.sep).join('/');
    const transcribed = await execute({
      input: {
        path: relative,
        languageCodes,
        mode: 'SMART',
        workspaceId,
        plan,
      },
      dataDirectory,
      env,
      quotaRepository,
    });
    return String(transcribed?.text || '').trim();
  });
}

async function wavFileDurationMs(file) {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return wavDurationMs(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function wavDurationMs(buffer) {
  if (!buffer || buffer.length < 44) return 0;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return 0;
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 24 <= buffer.length) {
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bits = buffer.readUInt16LE(offset + 22);
    }
    if (id === 'data') {
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!sampleRate || !channels || !bits || !dataSize) return 0;
  return Math.round((dataSize / (sampleRate * channels * (bits / 8))) * 1000);
}
