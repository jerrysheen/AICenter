import {appendFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';

let attached = null;

function dayStamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function finishWrite(encoding, callback) {
  const done = typeof encoding === 'function' ? encoding : callback;
  if (typeof done === 'function') done();
  return true;
}

export function attachDailyProcessLog({directory, name, now = () => new Date(), stdout = process.stdout, stderr = process.stderr} = {}) {
  if (attached) return attached;
  const dir = String(directory || '').trim();
  const prefix = String(name || '').trim();
  if (!dir || !/^[A-Za-z0-9_-]+$/.test(prefix)) return null;
  try { mkdirSync(dir, {recursive: true}); } catch { return null; }

  function appendChunk(kind, chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
    if (!text) return;
    const file = path.join(dir, `${prefix}.${kind}.${dayStamp(now())}.log`);
    try {
      appendFileSync(file, text);
    } catch (error) {
      if (error?.code !== 'ENOENT') return;
      try {
        mkdirSync(dir, {recursive: true});
        appendFileSync(file, text);
      } catch { /* a log failure must not stop the process */ }
    }
  }

  function hook(stream, kind) {
    const original = stream.write.bind(stream);
    stream.write = function patchedWrite(chunk, encoding, callback) {
      appendChunk(kind, chunk);
      // Keep the file log, and mirror while the pipe still accepts data.
      // A reader that has stopped leaves writableNeedDrain set; skipping that
      // write keeps a full pipe from blocking the process.
      if (stream.writableNeedDrain) return finishWrite(encoding, callback);
      return original(chunk, encoding, callback);
    };
    return () => { stream.write = original; };
  }

  const restore = [hook(stdout, 'out'), hook(stderr, 'error')];
  attached = {
    directory: dir,
    name: prefix,
    detach() {
      for (const restoreOne of restore) restoreOne();
      attached = null;
    },
  };
  return attached;
}

export function detachDailyProcessLog() {
  attached?.detach();
}

const directory = String(process.env.AI_CENTER_LOG_DIR || '').trim();
const name = String(process.env.AI_CENTER_LOG_NAME || '').trim();
if (directory && name) attachDailyProcessLog({directory, name});
