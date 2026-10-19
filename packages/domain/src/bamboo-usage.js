// Shared Bamboo admission counter. Web and Worker both read and write
// data/bamboo-usage-YYYYMMDD.json. The file is the Shanghai day. A restart
// reads the same file, so the count does not go back to zero.

import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';

const LOCK_WAIT_MS = 3_000;
const LOCK_STALE_MS = 5_000;

export function shanghaiUsageStamp(at = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';
  let hour = Number(pick('hour'));
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) hour = 0;
  return { day: `${pick('year')}${pick('month')}${pick('day')}`, hour };
}

export function bambooUsagePath(directory, day) {
  return path.join(directory, `bamboo-usage-${day}.json`);
}

export function hourlyAllowance({ max, countBeforeHour, hour }) {
  const hoursLeft = Math.max(1, 24 - Number(hour));
  const remaining = Math.max(0, Number(max) - Number(countBeforeHour));
  if (!Number.isFinite(remaining)) return 0;
  return Math.floor(remaining / hoursLeft);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockIsLive(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    const at = Number(parsed.at);
    if (!Number.isFinite(at) || Date.now() - at >= LOCK_STALE_MS) return false;
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

function withUsageLock(lockPath, fn) {
  const started = Date.now();
  while (true) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!lockIsLive(lockPath)) {
        try { unlinkSync(lockPath); } catch { /* the other process already removed it */ }
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        const timeout = new Error('Bamboo 用量文件锁超时');
        timeout.code = 'BAMBOO_USAGE_LOCK';
        throw timeout;
      }
      sleepMs(10);
      continue;
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      return fn();
    } finally {
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(lockPath); } catch { /* already released */ }
    }
  }
}

function emptyUsage() {
  return { count: 0, hour: -1, hourCount: 0 };
}

function readUsage(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const count = Number(parsed?.count);
    const hour = Number(parsed?.hour);
    const hourCount = Number(parsed?.hourCount);
    const safeCount = Number.isInteger(count) && count >= 0 ? count : 0;
    const safeHour = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : -1;
    const safeHourCount = Number.isInteger(hourCount) && hourCount >= 0 ? Math.min(hourCount, safeCount) : 0;
    return { count: safeCount, hour: safeHour, hourCount: safeHourCount };
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyUsage();
    const bad = new Error('Bamboo 用量文件无法读取');
    bad.code = 'BAMBOO_USAGE_READ';
    throw bad;
  }
}

const RENAME_ATTEMPTS = 3;
const RENAME_WAIT_MS = 20;

function renameReplacing(from, to, rename) {
  let last = null;
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      last = error;
      const retryable = error?.code === 'EPERM' || error?.code === 'EBUSY';
      if (!retryable || attempt === RENAME_ATTEMPTS - 1) break;
      sleepMs(RENAME_WAIT_MS);
    }
  }
  const wrapped = new Error('Bamboo 用量文件无法写入');
  wrapped.code = 'BAMBOO_USAGE_WRITE';
  const cause = typeof last?.code === 'string' && /^[A-Za-z0-9_]+$/.test(last.code) ? last.code : 'unknown';
  wrapped.causeCode = cause;
  throw wrapped;
}

function writeUsage(filePath, data, rename = renameSync) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  try {
    renameReplacing(tmp, filePath, rename);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* the replacement did not happen */ }
    throw error;
  }
}

export function readBambooUsage(directory, at = Date.now()) {
  const stamp = shanghaiUsageStamp(at);
  const usage = readUsage(bambooUsagePath(directory, stamp.day));
  const hourCount = usage.hour === stamp.hour ? usage.hourCount : 0;
  return { day: stamp.day, hour: stamp.hour, count: usage.count, hourCount };
}

export function resolveBambooDailySpread(env = process.env) {
  return String(env?.AI_CENTER_BAMBOO_DAILY_SPREAD ?? '').trim().toLowerCase() === 'hourly' ? 'hourly' : 'fifo';
}

// One admission call. Returns ok:false without writing when the daily cap,
// or the current hour's share, is already used.
export function takeBambooUsageSlot({ directory, max, spread = 'fifo', at = Date.now(), rename = renameSync } = {}) {
  const stamp = shanghaiUsageStamp(at);
  const limit = Number(max);
  const denied = (reason, usage, allowance = null, category = '') => ({
    ok: false,
    reason,
    day: stamp.day,
    hour: stamp.hour,
    count: usage.count,
    hourCount: usage.hour === stamp.hour ? usage.hourCount : 0,
    allowance,
    category,
  });
  if (!directory || typeof directory !== 'string') return denied('daily', emptyUsage());
  if (!Number.isInteger(limit) || limit < 0) return denied('daily', emptyUsage());
  const filePath = bambooUsagePath(directory, stamp.day);
  const lockPath = `${filePath}.lock`;
  try {
    return withUsageLock(lockPath, () => {
      const usage = readUsage(filePath);
      const hourCount = usage.hour === stamp.hour ? usage.hourCount : 0;
      const current = { count: usage.count, hour: stamp.hour, hourCount };
      if (current.count >= limit) return denied('daily', current);
      if (spread === 'hourly') {
        const allowance = hourlyAllowance({
          max: limit,
          countBeforeHour: current.count - hourCount,
          hour: stamp.hour,
        });
        if (hourCount >= allowance) return denied('hourly', current, allowance);
      }
      const next = {
        date: stamp.day,
        count: current.count + 1,
        hour: stamp.hour,
        hourCount: hourCount + 1,
      };
      writeUsage(filePath, next, rename);
      return { ok: true, reason: '', day: stamp.day, hour: stamp.hour, count: next.count, hourCount: next.hourCount, allowance: null };
    });
  } catch (error) {
    const code = error?.code;
    if (code === 'BAMBOO_USAGE_LOCK' || code === 'BAMBOO_USAGE_READ' || code === 'BAMBOO_USAGE_WRITE') {
      const category = code === 'BAMBOO_USAGE_WRITE' ? (error.causeCode || code) : code;
      return denied('usage-error', emptyUsage(), null, category);
    }
    throw error;
  }
}
