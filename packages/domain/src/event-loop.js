import { createHash } from 'node:crypto';

export function yieldEventLoop() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

const HASH_CHUNK = 32_768;

export async function hashTextYielding(text) {
  const value = String(text ?? '');
  if (value.length <= HASH_CHUNK) return createHash('sha256').update(value).digest('hex');
  const hash = createHash('sha256');
  for (let offset = 0; offset < value.length; offset += HASH_CHUNK) {
    hash.update(value.slice(offset, offset + HASH_CHUNK));
    if (offset + HASH_CHUNK < value.length) await yieldEventLoop();
  }
  return hash.digest('hex');
}
