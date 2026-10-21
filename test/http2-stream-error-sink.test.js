import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { spawn } from 'node:child_process';
import {
  absorbHttp2TeardownError,
  http2StreamErrorSinkInstalled,
  http2TeardownErrorCount,
  installHttp2StreamErrorSink,
} from '../packages/connectors/src/http2-stream-error-sink.js';

function childSource(install) {
  return `
    import http2 from 'node:http2';
    ${install ? "import { installHttp2StreamErrorSink } from './packages/connectors/src/http2-stream-error-sink.js'; installHttp2StreamErrorSink();" : ''}
    const server = http2.createServer();
    server.on('error', () => {});
    server.on('stream', (stream) => {
      stream.respond({ ':status': 200 });
      stream.end('ok');
    });
    server.listen(0, '127.0.0.1', () => {
      const session = http2.connect('http://127.0.0.1:' + server.address().port);
      session.on('error', () => {});
      const stream = session.request({ ':path': '/', ':method': 'GET' });
      stream.resume();
      stream.on('end', () => {
        for (const listener of stream.listeners('error')) {
          if (listener.name !== 'absorbHttp2TeardownError') stream.off('error', listener);
        }
        stream.destroy(Object.assign(new Error('socket idle timeout'), { code: 'UND_ERR_INFO' }));
        setTimeout(() => {
          console.log('still-alive');
          session.close();
          server.close();
        }, 40);
      });
    });
  `;
}

function runChild(install) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource(install)], { cwd: process.cwd() });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const closed = new Promise((resolve) => child.on('close', resolve));
  const code = Promise.race([
    closed,
    new Promise((resolve) => setTimeout(() => { child.kill(); resolve('timeout'); }, 5000)),
  ]);
  return code.then((exitCode) => ({ exitCode, out, err }));
}

test('a client stream error for socket idle timeout exits when nothing is listening', { timeout: 8000 }, async () => {
  const result = await runChild(false);
  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.err}\n${result.out}`, /socket idle timeout/);
  assert.doesNotMatch(result.out, /still-alive/);
});

test('the stream error sink keeps the process up after undici drops its own listener', { timeout: 8000 }, async () => {
  const result = await runChild(true);
  assert.equal(result.exitCode, 0, result.err);
  assert.match(result.out, /still-alive/);
  assert.match(result.out, /\[worker\] http2 stream error absorbed count=\d+ socket idle timeout/);
  assert.doesNotMatch(result.err, /Unhandled/);
});

test('installing the sink is idempotent and a request still completes', async () => {
  assert.equal(installHttp2StreamErrorSink(), true);
  assert.equal(installHttp2StreamErrorSink(), false);
  assert.equal(http2StreamErrorSinkInstalled(), true);
  const server = http2.createServer();
  server.on('stream', (stream) => {
    stream.respond({ ':status': 200 });
    stream.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const session = http2.connect(`http://127.0.0.1:${server.address().port}`);
  try {
    const stream = session.request({ ':path': '/', ':method': 'GET' });
    const body = await new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
      stream.on('error', reject);
    });
    assert.equal(body, 'ok');
    assert.equal(stream.listeners('error').includes(absorbHttp2TeardownError), true);
    for (const listener of [...stream.listeners('error')]) {
      if (listener !== absorbHttp2TeardownError) stream.off('error', listener);
    }
    assert.deepEqual(stream.listeners('error'), [absorbHttp2TeardownError]);
    const before = http2TeardownErrorCount();
    const lines = [];
    const original = console.debug;
    console.debug = (...args) => { lines.push(args.join(' ')); };
    try {
      stream.destroy(Object.assign(new Error('socket idle timeout'), { code: 'UND_ERR_INFO' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      console.debug = original;
    }
    assert.equal(http2TeardownErrorCount(), before + 1);
    assert.match(lines.join('\n'), /\[worker\] http2 stream error absorbed count=\d+ socket idle timeout/);
  } finally {
    session.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
