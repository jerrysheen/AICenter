import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const RESTART_REQUEST_NAME = 'restart.request';
const DEFAULT_COOLDOWN_MS = 8_000;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function restartRequestPath(runtimeDirectory) {
  return path.join(text(runtimeDirectory), RESTART_REQUEST_NAME);
}

export function requestLauncherRestart(runtimeDirectory, {
  now = Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
  reason = '',
} = {}) {
  const root = text(runtimeDirectory);
  if (!root) return { requested: false, reason: 'no-runtime' };
  mkdirSync(root, { recursive: true });
  const file = restartRequestPath(root);
  if (existsSync(file)) {
    const stamped = Date.parse(readFileSync(file, 'utf8').trim().split(/\s/)[0] || '');
    const age = now - stamped;
    if (Number.isFinite(age) && age >= 0 && age < cooldownMs) {
      return { requested: false, reason: 'cooldown', path: file };
    }
  }
  const stamp = new Date(now).toISOString();
  const note = text(reason) ? `${stamp} ${text(reason)}` : stamp;
  writeFileSync(file, `${note}\n`, 'utf8');
  return { requested: true, path: file };
}

export function createLauncherRestartPort({ runtimeDirectory, now } = {}) {
  return Object.freeze({
    requestRestart(input = {}) {
      return requestLauncherRestart(runtimeDirectory, {
        reason: input.reason || input.scope || '',
        now: typeof now === 'function' ? now() : Date.now(),
      });
    },
  });
}
