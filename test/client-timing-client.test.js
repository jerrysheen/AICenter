import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_TIMING_SAMPLE,
  clientTimingPayload,
  installClientTiming,
  postClientTiming,
  readNavigationTiming,
  shouldReportClientTiming,
} from '../apps/web/public/client-timing.js';

test('a normal page load is reported even without a navigation entry', () => {
  assert.equal(CLIENT_TIMING_SAMPLE, 1);
  assert.equal(shouldReportClientTiming(0, 1), true);
  assert.equal(shouldReportClientTiming(0.2, 0.2), false);
  const nav = readNavigationTiming(null, null);
  assert.deepEqual(nav, { dns: 0, connect: 0, tls: 0, ttfb: 0, download: 0, domContentLoaded: 0, load: 0 });
  const payload = JSON.parse(clientTimingPayload({
    href: 'https://tradingplus.cn/?token=secret&v=dev#sources',
    origin: 'https://tradingplus.cn',
    navigation: null,
    resources: [
      { name: 'https://tradingplus.cn/app.js?v=dev', initiatorType: 'script', duration: 12, responseStart: 3, requestStart: 1, transferSize: 20 },
      { name: 'https://evil.example/tracker.js', initiatorType: 'script', duration: 99, responseStart: 1, requestStart: 0, transferSize: 1 },
    ],
  }));
  assert.equal(payload.path, '/?v=dev');
  assert.equal(payload.nav.load, 0);
  assert.equal(payload.resources.length, 1);
  assert.equal(payload.resources[0].name, '/app.js?v=dev');
  assert.equal(JSON.stringify(payload).includes('secret'), false);
  assert.equal(JSON.stringify(payload).includes('evil.example'), false);
});

test('page load timing posts text/plain while the document is still open', async () => {
  const calls = [];
  const sent = postClientTiming('{"path":"/","nav":{},"resources":[]}', {
    fetch(_url, options) {
      calls.push(options);
      return Promise.resolve();
    },
    sendBeacon() {
      throw new Error('beacon should not run when fetch is available');
    },
  });
  assert.equal(sent, 'fetch');
  assert.equal(calls[0].headers['Content-Type'], 'text/plain');
  assert.equal(calls[0].credentials, 'same-origin');
  assert.equal(calls[0].keepalive, true);
});

test('sendBeacon uses text/plain when fetch is unavailable', () => {
  const blobs = [];
  class BlobStub {
    constructor(parts, options) {
      blobs.push({ parts, options });
    }
  }
  const sent = postClientTiming('{"path":"/"}', {
    sendBeacon(_url, blob) {
      blobs.push({ blob });
      return true;
    },
    Blob: BlobStub,
  });
  assert.equal(sent, 'beacon');
  assert.equal(blobs[0].options.type, 'text/plain');
});

test('a completed document load reports once without a navigation entry', () => {
  const calls = [];
  const listeners = {};
  const timers = [];
  const win = {
    document: { readyState: 'complete' },
    location: { href: 'https://tradingplus.cn/?token=secret&v=dev', origin: 'https://tradingplus.cn' },
    performance: {
      getEntriesByType() { return []; },
      timing: null,
    },
    fetch(url, options) {
      calls.push({ url, options });
      return Promise.resolve();
    },
    navigator: {},
    setTimeout(fn, delay) {
      timers.push(delay);
      if (delay === 0) fn();
      return timers.length;
    },
    addEventListener(name, fn) { listeners[name] = fn; },
  };
  installClientTiming(win);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/runtime/client-timing');
  assert.equal(calls[0].options.headers['Content-Type'], 'text/plain');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.path, '/?v=dev');
  assert.equal(body.nav.ttfb, 0);
  assert.equal(body.nav.load, 0);
  assert.equal(JSON.stringify(body).includes('secret'), false);
  listeners.load?.();
  assert.equal(calls.length, 1);
  assert.equal(timers.includes(8000), true);
});
