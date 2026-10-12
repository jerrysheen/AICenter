import { existsSync, readFileSync } from 'node:fs';

const COMMIT = /^[0-9a-f]{7,64}$/i;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/*-]{0,119}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const HISTORY_LIMIT = 20;

export function emptyDeployStatus() {
  return { ok: true, current: null, history: [] };
}

function text(value, pattern) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  return pattern.test(raw) ? raw : '';
}

function reasonText(value) {
  if (typeof value !== 'string') return '';
  const raw = value.replace(/\s+/g, ' ').trim();
  if (!raw || raw.length > 200) return '';
  if (/[\\/\r\n]|:\/\//.test(raw)) return '';
  return raw;
}

function errorText(value) {
  if (typeof value !== 'string') return '';
  let raw = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!raw) return '';
  raw = raw
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1redacted@')
    .replace(/\b(password|api[_-]?key|secret|token)\s*[=:]\s*\S+/gi, '$1=<redacted>')
    .replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>');
  if (raw.length > 4000) raw = raw.slice(0, 4000);
  return raw;
}

export function projectDeployRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const commit = text(value.commit, COMMIT).toLowerCase();
  const previousCommit = text(value.previousCommit, COMMIT).toLowerCase();
  if (value.commit && !commit) return null;
  if (value.previousCommit && !previousCommit) return null;
  let ref = text(value.ref, REF);
  if (value.ref && (!ref || ref.includes('..') || ref.includes('//'))) ref = '';
  return {
    commit,
    previousCommit,
    ref,
    startedAt: text(value.startedAt, STAMP),
    finishedAt: text(value.finishedAt, STAMP),
    ok: value.ok === true,
    restarted: value.restarted === true,
    rolledBack: value.rolledBack === true,
    reason: reasonText(value.reason),
    npmCi: value.npmCi === true,
    state: value.state === 'error' ? 'error' : '',
    error: errorText(value.error),
    at: text(value.at, STAMP),
  };
}

export function projectDeployStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyDeployStatus();
  const history = Array.isArray(value.history)
    ? value.history.map((item) => projectDeployRecord(item)).filter(Boolean).slice(0, HISTORY_LIMIT)
    : [];
  const current = value.current == null ? null : projectDeployRecord(value.current);
  return { ok: true, current, history };
}

export function readDeployStatus(filePath) {
  if (!filePath || !existsSync(filePath)) return emptyDeployStatus();
  try {
    return projectDeployStatus(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    return emptyDeployStatus();
  }
}
