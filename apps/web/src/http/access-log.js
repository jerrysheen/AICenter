import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const MAX_QUEUE = 4000;
const MAX_SUMMARY_LINES = 500_000;
const MAX_SUMMARY_DAYS = 16;
const CLIENT_TIMING_PER_MINUTE = 300;
const NAV_KEYS = ['dns', 'connect', 'tls', 'ttfb', 'download', 'domContentLoaded', 'load'];

export const accessCacheHit = Symbol('accessCacheHit');
const attachedFlag = Symbol('accessLogAttached');

export function accessLogEnabled(env = {}) {
  const raw = String(env.AI_CENTER_ACCESS_LOG ?? '1').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

export function accessLogRetentionDays(env = {}) {
  const parsed = Number(env.AI_CENTER_ACCESS_LOG_RETENTION_DAYS ?? 14);
  if (!Number.isFinite(parsed)) return 14;
  return Math.min(90, Math.max(1, Math.trunc(parsed)));
}

export function clientTimingSampleRate(env = {}) {
  const raw = env.AI_CENTER_CLIENT_TIMING_SAMPLE;
  if (raw == null || String(raw).trim() === '') return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(1, Math.max(0, parsed));
}

export function shanghaiDate(epochMs = Date.now()) {
  return new Date(epochMs + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function formatShanghai(epochMs) {
  const iso = new Date(epochMs + SHANGHAI_OFFSET_MS).toISOString();
  return `${iso.slice(0, -1)}+08:00`;
}

function asUrl(input) {
  if (input instanceof URL) return input;
  try {
    return new URL(String(input || '/'), 'http://localhost');
  } catch {
    return null;
  }
}

export function safeRequestPath(input) {
  const url = asUrl(input);
  if (!url) return '/';
  const pathname = url.pathname || '/';
  const version = url.searchParams?.get('v') || '';
  if (/^[A-Za-z0-9._-]{1,64}$/.test(version)) return `${pathname}?v=${version}`.slice(0, 180);
  return pathname.slice(0, 180);
}

export function userAgentClass(userAgent) {
  const value = String(userAgent || '');
  if (!value.trim()) return 'other';
  if (/bot|spider|crawl|slurp|preview|facebookexternal|whatsapp|telegram|embedly|wget|curl|python-requests|go-http-client|headless/i.test(value)) {
    return 'bot';
  }
  if (/mobile|android|iphone|ipad|ipod|iemobile|webos|blackberry/i.test(value)) return 'mobile';
  if (/windows|macintosh|mac os|linux|cros|x11/i.test(value)) return 'desktop';
  return 'other';
}

export function hashClientAddress(value, salt) {
  const raw = String(value || '').trim();
  if (!raw || !salt) return '';
  return createHash('sha256').update(`${salt}\0${raw}`).digest('hex').slice(0, 16);
}

function cfRay(value) {
  const raw = String(value || '').trim();
  return /^[A-Za-z0-9-]{1,64}$/.test(raw) ? raw : '';
}

function finiteMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(Math.min(number, 600_000));
}

function byteLength(chunk, encoding) {
  if (chunk == null || typeof chunk === 'function') return 0;
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (typeof chunk !== 'string') return 0;
  const enc = typeof encoding === 'string' ? encoding : 'utf8';
  try {
    return Buffer.byteLength(chunk, enc);
  } catch {
    return Buffer.byteLength(chunk);
  }
}

function cacheControlValue(headers) {
  if (!headers) return '';
  if (Array.isArray(headers)) {
    for (let index = 0; index < headers.length - 1; index += 2) {
      if (String(headers[index]).toLowerCase() === 'cache-control') return String(headers[index + 1] ?? '');
    }
    return '';
  }
  if (typeof headers !== 'object') return '';
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'cache-control') continue;
    return Array.isArray(value) ? value.map(String).join(', ') : String(value ?? '');
  }
  return '';
}

function writeHeaders(statusMessage, headers) {
  if (typeof statusMessage === 'object' && statusMessage !== null) return statusMessage;
  return headers;
}

export function createDailyLogWriter({ directory, prefix, retentionDays = 14, now = () => Date.now() } = {}) {
  const dir = String(directory || '');
  const name = String(prefix || 'access');
  const queue = [];
  let stream = null;
  let currentDay = '';
  let closed = false;
  let chain = Promise.resolve();

  function fileFor(day) {
    return path.join(dir, `${name}.${day}.log`);
  }

  function prune(today) {
    if (!dir) return;
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const limit = shanghaiDate(now() - retentionDays * DAY_MS);
    const pattern = new RegExp(`^${name}\\.(\\d{4}-\\d{2}-\\d{2})\\.log$`);
    for (const entry of entries) {
      const match = pattern.exec(entry);
      if (!match || match[1] > limit) continue;
      try {
        unlinkSync(path.join(dir, entry));
      } catch {
        // 删不掉就留到下一次轮转。
      }
    }
  }

  function open(day) {
    mkdirSync(dir, { recursive: true });
    if (stream && currentDay === day) return;
    const previous = stream;
    stream = createWriteStream(fileFor(day), { flags: 'a' });
    stream.on('error', () => {
      stream = null;
    });
    currentDay = day;
    if (previous) previous.end();
    prune(day);
  }

  function writeQueue() {
    if (closed || !queue.length) return Promise.resolve();
    const day = shanghaiDate(now());
    let chunk = '';
    try {
      open(day);
      chunk = queue.splice(0, queue.length).join('');
    } catch {
      stream = null;
      queue.length = 0;
      return Promise.resolve();
    }
    if (!chunk || !stream) return Promise.resolve();
    const target = stream;
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(done, 2000);
      timer.unref?.();
      try {
        target.write(chunk, 'utf8', () => {
          clearTimeout(timer);
          done();
        });
      } catch {
        clearTimeout(timer);
        if (stream === target) stream = null;
        done();
      }
    }).then(() => (queue.length && !closed ? writeQueue() : undefined));
  }

  function enqueue(line) {
    if (closed) return;
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(line);
    chain = chain.then(writeQueue).catch(() => {});
  }

  function flush() {
    return chain.then(() => writeQueue()).catch(() => {});
  }

  function close() {
    return flush().then(() => new Promise((resolve) => {
      closed = true;
      if (!stream) return resolve();
      stream.end(() => resolve());
    })).catch(() => {});
  }

  return { enqueue, close, flush, prune };
}

export function requestLoopDelayMs(histogram, startMax) {
  if (!histogram || startMax == null) return null;
  const endMax = Number(histogram.max);
  if (!Number.isFinite(endMax) || !Number.isFinite(Number(startMax))) return null;
  const delta = endMax >= startMax ? endMax - startMax : endMax;
  return Math.max(0, Math.round(delta / 1e6));
}

function attach(request, response, url, writer, { salt, now, loopDelay }) {
  const receivedPerf = performance.now();
  const receivedWall = now();
  const loopHistogram = () => (typeof loopDelay === 'function' ? loopDelay() : loopDelay);
  const loopStart = loopHistogram();
  const loopStartMax = loopStart && Number.isFinite(Number(loopStart.max)) ? Number(loopStart.max) : null;
  let marked = false;
  let firstPerf = 0;
  let bytesSent = 0;
  let status = 0;
  let cacheControl = '';
  let sawFinish = false;
  let aborted = false;
  let emitted = false;

  const mark = () => {
    if (marked) return;
    marked = true;
    firstPerf = performance.now();
  };

  const originalWriteHead = response.writeHead;
  response.writeHead = function writeHead(statusCode, statusMessage, headers) {
    mark();
    status = Number(statusCode) || status;
    const found = cacheControlValue(writeHeaders(statusMessage, headers));
    if (found) cacheControl = found;
    return originalWriteHead.apply(this, arguments);
  };

  const originalWrite = response.write;
  response.write = function write(chunk, encoding, callback) {
    mark();
    try {
      bytesSent += byteLength(chunk, encoding);
    } catch {
      // 字节计数失败不影响响应。
    }
    return originalWrite.apply(this, arguments);
  };

  const originalEnd = response.end;
  response.end = function end(chunk, encoding, callback) {
    mark();
    const before = bytesSent;
    const size = byteLength(chunk, encoding);
    const result = originalEnd.apply(this, arguments);
    if (bytesSent === before) bytesSent += size;
    return result;
  };

  const originalSetHeader = response.setHeader;
  if (typeof originalSetHeader === 'function') {
    response.setHeader = function setHeader(name, value) {
      if (String(name).toLowerCase() === 'cache-control') {
        cacheControl = Array.isArray(value) ? value.map(String).join(', ') : String(value ?? '');
      }
      return originalSetHeader.call(this, name, value);
    };
  }

  request.on?.('aborted', () => {
    aborted = true;
  });

  const emit = () => {
    if (emitted) return;
    emitted = true;
    try {
      const finishedPerf = performance.now();
      const finishedWall = receivedWall + (finishedPerf - receivedPerf);
      const firstWall = marked ? receivedWall + (firstPerf - receivedPerf) : null;
      const headerControl = cacheControl || String(response.getHeader?.('cache-control') || '');
      const statusCode = status || Number(response.statusCode) || 0;
      const hit = response[accessCacheHit];
      const client = hashClientAddress(request.headers?.['cf-connecting-ip'], salt);
      const ray = cfRay(request.headers?.['cf-ray']);
      const loopMs = requestLoopDelayMs(loopHistogram(), loopStartMax);
      const record = {
        receivedAt: formatShanghai(receivedWall),
        firstByteAt: firstWall == null ? null : formatShanghai(firstWall),
        finishedAt: formatShanghai(finishedWall),
        aborted: Boolean(aborted || !sawFinish),
        bytesSent,
        status: statusCode,
        method: String(request.method || ''),
        path: safeRequestPath(url),
        cache: {
          control: headerControl,
          notModified: statusCode === 304,
          ...(hit === true || hit === false ? { hit } : {}),
        },
        ...(ray ? { cfRay: ray } : {}),
        ...(client ? { client } : {}),
        ua: userAgentClass(request.headers?.['user-agent']),
        serverMs: marked ? Math.round(firstPerf - receivedPerf) : null,
        transferMs: marked ? Math.round(finishedPerf - firstPerf) : null,
        totalMs: Math.round(finishedPerf - receivedPerf),
        ...(loopMs == null ? {} : { loopMs }),
      };
      if (loopMs != null && loopMs >= 200) {
        console.warn(`[web] event-loop ${record.method} ${record.path} loopMs=${loopMs}`);
      }
      writer.enqueue(`${JSON.stringify(record)}\n`);
    } catch {
      // 日志失败不能影响请求。
    }
  };

  response.on?.('finish', () => {
    sawFinish = true;
    emit();
  });
  response.on?.('close', () => {
    if (!sawFinish) aborted = true;
    emit();
  });
}

export function createAccessLog(options = {}) {
  const env = options.env || {};
  const enabled = options.enabled ?? accessLogEnabled(env);
  const directory = String(options.directory || '');
  const now = options.now || (() => Date.now());
  const salt = options.salt || randomBytes(16).toString('hex');
  const retentionDays = options.retentionDays ?? accessLogRetentionDays(env);
  const sampleRate = options.clientSampleRate ?? clientTimingSampleRate(env);
  const writersReady = Boolean(enabled && directory);
  let loopDelay = null;
  let clientWindow = { start: 0, count: 0 };
  const accessWriter = writersReady
    ? createDailyLogWriter({ directory, prefix: 'access', retentionDays, now })
    : null;
  const clientWriter = writersReady
    ? createDailyLogWriter({ directory, prefix: 'client-timing', retentionDays, now })
    : null;

  function observe(request, response, url) {
    if (!accessWriter || !request || !response || response[attachedFlag]) return;
    try {
      response[attachedFlag] = true;
      attach(request, response, url, accessWriter, { salt, now, loopDelay: () => loopDelay });
    } catch {
      // 请求路径上不能抛出。
    }
  }

  function writeClientTiming(record) {
    if (!clientWriter || !record) return;
    try {
      clientWriter.enqueue(`${JSON.stringify(record)}\n`);
    } catch {
      // 忽略。
    }
  }

  function bindLoopDelay(histogram) {
    loopDelay = histogram || null;
  }

  function writeEventLoop(sample) {
    if (!accessWriter || !sample) return;
    try {
      const at = Number(sample.at) || now();
      accessWriter.enqueue(`${JSON.stringify({
        kind: 'event-loop',
        receivedAt: formatShanghai(at),
        loopP50Ms: Math.round(Number(sample.p50Ms) || 0),
        loopP99Ms: Math.round(Number(sample.p99Ms) || 0),
        loopMaxMs: Math.round(Number(sample.maxMs) || 0),
      })}\n`);
    } catch {
      // 忽略。
    }
  }

  function acceptClientSample(random = Math.random(), at = Date.now()) {
    if (!writersReady || !(random < sampleRate)) return false;
    if (at - clientWindow.start >= 60_000) clientWindow = { start: at, count: 0 };
    if (clientWindow.count >= CLIENT_TIMING_PER_MINUTE) return false;
    clientWindow.count += 1;
    return true;
  }

  function flush() {
    return Promise.all([
      accessWriter ? accessWriter.flush() : Promise.resolve(),
      clientWriter ? clientWriter.flush() : Promise.resolve(),
    ]).then(() => {});
  }

  function close() {
    return Promise.all([
      accessWriter ? accessWriter.close() : Promise.resolve(),
      clientWriter ? clientWriter.close() : Promise.resolve(),
    ]).then(() => {});
  }

  return {
    enabled: writersReady,
    directory,
    salt,
    observe,
    writeClientTiming,
    writeEventLoop,
    bindLoopDelay,
    acceptClientSample,
    flush,
    close,
  };
}

function safeResourceName(value, requestHost) {
  const raw = String(value || '').trim().slice(0, 300);
  if (!raw) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return '';
    }
    const host = String(requestHost || '').split(':')[0].toLowerCase();
    if (host && url.hostname.toLowerCase() !== host) return '';
    return safeRequestPath(url);
  }
  if (!raw.startsWith('/')) return '';
  return safeRequestPath(raw);
}

export function clientTimingAllowed(request) {
  const site = String(request?.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site' || site === 'same-site') return false;
  const origin = String(request?.headers?.origin || '');
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(request?.headers?.host || '').toLowerCase();
  } catch {
    return false;
  }
}

export function projectClientTiming(body, request, { salt = '', now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const navIn = body.nav;
  if (!navIn || typeof navIn !== 'object' || Array.isArray(navIn)) return null;
  const nav = {};
  for (const key of NAV_KEYS) {
    const value = finiteMs(navIn[key]);
    if (value == null) return null;
    nav[key] = value;
  }
  const host = request?.headers?.host;
  const resources = [];
  const list = Array.isArray(body.resources) ? body.resources : [];
  for (const item of list) {
    if (resources.length >= 20) break;
    if (!item || typeof item !== 'object') continue;
    const name = safeResourceName(item.name, host);
    const dur = finiteMs(item.dur);
    if (!name || dur == null) continue;
    resources.push({
      name,
      type: String(item.type || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 24),
      dur,
      ttfb: finiteMs(item.ttfb) ?? 0,
      size: finiteMs(item.size) ?? 0,
    });
  }
  const client = hashClientAddress(request?.headers?.['cf-connecting-ip'], salt);
  const ray = cfRay(request?.headers?.['cf-ray']);
  return {
    receivedAt: formatShanghai(now),
    path: safeResourceName(body.path, host) || '/',
    ua: userAgentClass(request?.headers?.['user-agent']),
    nav,
    resources,
    ...(ray ? { cfRay: ray } : {}),
    ...(client ? { client } : {}),
  };
}

function calendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

export function parseSince(value, now = Date.now()) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const relative = /^(\d{1,6})(s|m|h|d)$/.exec(raw);
  if (relative) {
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS }[relative[2]];
    return now - Number(relative[1]) * unit;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseSummaryOptions(input = {}, now = () => Date.now()) {
  const current = now();
  const date = String(input.date || '').trim() || shanghaiDate(current);
  if (!calendarDate(date)) return { error: '日期无效' };
  const topRaw = input.top == null || input.top === '' ? 20 : Number(input.top);
  if (!Number.isFinite(topRaw) || topRaw <= 0) return { error: '条数无效' };
  const top = Math.min(100, Math.trunc(topRaw));
  let sinceMs = null;
  if (input.since) {
    sinceMs = parseSince(input.since, current);
    if (sinceMs == null) return { error: '起始时间无效' };
  }
  return { date, top, sinceMs, now: current };
}

function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index];
}

function timingStats(values) {
  if (!values.length) return { p50: null, p95: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

function summaryDays(date, sinceMs) {
  if (sinceMs == null) return [date];
  const start = shanghaiDate(sinceMs);
  let cursor = Date.parse(`${start}T00:00:00.000Z`);
  const end = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(cursor) || !Number.isFinite(end) || cursor > end) return [date];
  const days = [];
  for (let index = 0; index < MAX_SUMMARY_DAYS && cursor <= end; index += 1) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += DAY_MS;
  }
  return days.length ? days : [date];
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseAccessLine(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') return null;
    const receivedMs = Date.parse(value.receivedAt);
    if (!Number.isFinite(receivedMs)) return null;
    if (value.kind === 'event-loop') {
      return {
        kind: 'event-loop',
        receivedMs,
        loopP99Ms: numberOrNull(value.loopP99Ms),
        loopMaxMs: numberOrNull(value.loopMaxMs),
      };
    }
    if (value.kind) return null;
    return {
      path: typeof value.path === 'string' && value.path ? value.path : '/',
      bytesSent: numberOrNull(value.bytesSent) ?? 0,
      serverMs: numberOrNull(value.serverMs),
      transferMs: numberOrNull(value.transferMs),
      totalMs: numberOrNull(value.totalMs),
      loopMs: numberOrNull(value.loopMs),
      receivedMs,
    };
  } catch {
    return null;
  }
}

export async function readAccessSummary(directory, input = {}, now = () => Date.now()) {
  const parsed = parseSummaryOptions(input, now);
  if (parsed.error) return { ok: false, error: parsed.error };
  const groups = new Map();
  const loopSamples = [];
  let count = 0;
  let scanned = 0;
  let truncated = false;
  for (const day of summaryDays(parsed.date, parsed.sinceMs)) {
    const file = path.join(String(directory || ''), `access.${day}.log`);
    if (!existsSync(file)) continue;
    const lines = createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      scanned += 1;
      if (scanned > MAX_SUMMARY_LINES) {
        truncated = true;
        lines.close();
        break;
      }
      const record = parseAccessLine(line);
      if (!record) continue;
      if (parsed.sinceMs != null && record.receivedMs < parsed.sinceMs) continue;
      if (record.kind === 'event-loop') {
        loopSamples.push(record);
        continue;
      }
      count += 1;
      const bucket = groups.get(record.path) || {
        path: record.path,
        count: 0,
        bytes: 0,
        server: [],
        transfer: [],
        total: [],
        loop: [],
      };
      bucket.count += 1;
      bucket.bytes += record.bytesSent;
      if (record.serverMs != null) bucket.server.push(record.serverMs);
      if (record.transferMs != null) bucket.transfer.push(record.transferMs);
      if (record.totalMs != null) bucket.total.push(record.totalMs);
      if (record.loopMs != null) bucket.loop.push(record.loopMs);
      groups.set(record.path, bucket);
    }
  }
  const paths = [...groups.values()]
    .map((bucket) => ({
      path: bucket.path,
      count: bucket.count,
      bytes: bucket.bytes,
      serverMs: timingStats(bucket.server),
      transferMs: timingStats(bucket.transfer),
      total: timingStats(bucket.total),
      loopMs: timingStats(bucket.loop),
    }))
    .sort((left, right) => (right.total.p95 ?? -1) - (left.total.p95 ?? -1) || right.count - left.count)
    .slice(0, parsed.top);
  return {
    ok: true,
    date: parsed.date,
    since: parsed.sinceMs == null ? null : formatShanghai(parsed.sinceMs),
    top: parsed.top,
    count,
    truncated,
    eventLoop: summarizeEventLoop(loopSamples),
    paths,
  };
}

function summarizeEventLoop(samples) {
  const p99 = samples.map((sample) => sample.loopP99Ms).filter((value) => value != null);
  const maxes = samples.map((sample) => sample.loopMaxMs).filter((value) => value != null);
  return {
    count: samples.length,
    p99: timingStats(p99),
    max: maxes.length ? Math.max(...maxes) : null,
  };
}

function formatTiming(stats) {
  if (!stats || stats.p50 == null) return '-';
  return `${stats.p50}/${stats.p95}/${stats.max}`;
}

export function formatSummaryText(summary) {
  if (!summary?.ok) return summary?.error || '无法汇总';
  const header = [
    `date=${summary.date}`,
    `count=${summary.count}`,
    `top=${summary.top}`,
    summary.since ? `since=${summary.since}` : '',
    summary.truncated ? 'truncated=1' : '',
  ].filter(Boolean).join(' ');
  const loop = summary.eventLoop;
  const loopText = loop
    ? `eventLoop count=${loop.count} p99=${formatTiming(loop.p99)} max=${loop.max ?? '-'}`
    : '';
  const lines = [header, loopText].filter(Boolean);
  for (const row of summary.paths) {
    lines.push([
      row.path,
      `count=${row.count}`,
      `bytes=${row.bytes}`,
      `serverMs=${formatTiming(row.serverMs)}`,
      `transferMs=${formatTiming(row.transferMs)}`,
      `total=${formatTiming(row.total)}`,
      `loopMs=${formatTiming(row.loopMs)}`,
    ].join(' '));
  }
  if (!summary.paths.length) lines.push('(empty)');
  return lines.join('\n');
}
