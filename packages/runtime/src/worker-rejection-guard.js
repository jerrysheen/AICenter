// Node 22 treats an unhandled rejection as a fatal error and exits.
// The launcher then starts another Worker, and jobs left running are
// saved as WorkerLeaseExpired. One rejection is logged and the process
// stays up. A burst, or the same database error repeating, exits so the
// launcher can start a fresh Worker.

export const REJECTION_WINDOW_MS = 10 * 60 * 1000;
export const REJECTION_WINDOW_LIMIT = 20;
export const DATABASE_REJECTION_REPEAT_LIMIT = 3;

export function databaseRejectionKey(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (/^SQLITE_[A-Z0-9_]+$/.test(code)) return code;
  const message = error instanceof Error ? error.message : String(error ?? '');
  const first = message.split('\n')[0];
  const named = first.match(/SQLITE_[A-Z0-9_]+/);
  if (named) return named[0];
  if (/database is locked/i.test(first)) return 'SQLITE_BUSY';
  return '';
}

export function installWorkerRejectionGuard(target = process, log = console.error, options = {}) {
  const windowMs = options.windowMs ?? REJECTION_WINDOW_MS;
  const windowLimit = options.windowLimit ?? REJECTION_WINDOW_LIMIT;
  const databaseRepeatLimit = options.databaseRepeatLimit ?? DATABASE_REJECTION_REPEAT_LIMIT;
  const now = options.now ?? Date.now;
  const exit = options.exit ?? ((code) => process.exit(code));
  const recent = [];
  const databaseHits = new Map();
  let exited = false;

  const onRejection = (error) => {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    log(`[worker] unhandledRejection ${detail}`);
    if (exited) return;
    const at = now();
    recent.push(at);
    while (recent.length && at - recent[0] > windowMs) recent.shift();
    const dbKey = databaseRejectionKey(error);
    if (dbKey) {
      const hits = databaseHits.get(dbKey) || [];
      hits.push(at);
      while (hits.length && at - hits[0] > windowMs) hits.shift();
      if (hits.length) databaseHits.set(dbKey, hits);
      else databaseHits.delete(dbKey);
      if (hits.length >= databaseRepeatLimit) {
        exited = true;
        log(`[worker] unhandledRejection database ${dbKey} repeated ${hits.length} times, exiting`);
        exit(1);
        return;
      }
    }
    if (recent.length > windowLimit) {
      exited = true;
      log(`[worker] unhandledRejection ${recent.length} times in ${windowMs}ms, exiting`);
      exit(1);
    }
  };
  target.on('unhandledRejection', onRejection);
  return () => target.off('unhandledRejection', onRejection);
}
