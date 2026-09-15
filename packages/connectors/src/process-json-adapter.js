import { spawn } from 'node:child_process';

export class ConnectorProcessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ConnectorProcessError';
    this.details = details;
  }
}

export function createJsonProcessAdapter(options) {
  if (!options?.command) throw new Error('connector command is required');
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 60_000);
  const maxOutputBytes = Math.max(1_024, Number(options.maxOutputBytes) || 8 * 1024 * 1024);

  return async function runJsonProcess(input = {}, context = {}) {
    const args = typeof options.args === 'function' ? options.args(input) : (options.args || []);
    if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
      throw new ConnectorProcessError('connector args must be an array of strings');
    }

    return new Promise((resolve, reject) => {
      const child = spawn(options.command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env || {}) },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout = [];
      const stderr = [];
      let outputBytes = 0;
      let settled = false;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', abort);
        callback();
      };
      const abort = () => {
        child.kill();
        finish(() => reject(new ConnectorProcessError('connector execution cancelled', { kind: 'cancelled' })));
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(() => reject(new ConnectorProcessError(`connector timed out after ${timeoutMs}ms`, { kind: 'timeout' })));
      }, timeoutMs);

      context.signal?.addEventListener('abort', abort, { once: true });
      child.once('error', (error) => finish(() => reject(new ConnectorProcessError(
        `unable to start connector: ${error.message}`, { kind: 'spawn', cause: error.message },
      ))));
      child.stdout.on('data', (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          child.kill();
          finish(() => reject(new ConnectorProcessError('connector output exceeded the configured limit', { kind: 'output_limit' })));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk);
      });
      child.once('close', (code) => finish(() => {
        const errorText = Buffer.concat(stderr).toString('utf8').trim();
        if (code !== 0) {
          reject(new ConnectorProcessError(`connector exited with code ${code}`, {
            kind: 'exit', code, stderr: errorText.slice(0, 4_000),
          }));
          return;
        }
        const text = Buffer.concat(stdout).toString('utf8').trim();
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new ConnectorProcessError('connector did not return valid JSON', {
            kind: 'invalid_json', stderr: errorText.slice(0, 4_000),
          }));
        }
      }));
    });
  };
}
