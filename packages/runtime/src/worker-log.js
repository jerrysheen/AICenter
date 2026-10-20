import { modelUsageContext } from './model-usage-context.js';

export function stampWorkerLogLine(chunk, { at = new Date(), jobId = '' } = {}) {
  const when = at instanceof Date ? at : new Date(at);
  const iso = Number.isNaN(when.getTime()) ? new Date().toISOString() : when.toISOString();
  const prefix = `[worker] ${iso}${jobId ? ` job=${jobId}` : ''} `;
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
  if (!text) return text;
  const lines = text.split('\n');
  return lines.map((line, index) => (line === '' && index === lines.length - 1 ? '' : `${prefix}${line}`)).join('\n');
}

export function installWorkerLogStamps({
  stdout = process.stdout,
  stderr = process.stderr,
  jobId = () => modelUsageContext().jobId || '',
} = {}) {
  function wrap(stream) {
    const original = stream.write.bind(stream);
    stream.write = function patchedWrite(chunk, encoding, callback) {
      return original(stampWorkerLogLine(chunk, { jobId: jobId() || '' }), encoding, callback);
    };
    return () => { stream.write = original; };
  }
  const restore = [wrap(stdout), wrap(stderr)];
  return () => { for (const restoreOne of restore) restoreOne(); };
}
