/* 页面加载后上报 Navigation Timing。只打本站。普通打开都会记一条。 */
export const CLIENT_TIMING_SAMPLE = 1;
export const CLIENT_TIMING_ENDPOINT = '/api/v1/runtime/client-timing';

function rounded(value) {
  var number = Number(value);
  if (!isFinite(number) || number < 0) return 0;
  if (number > 600000) return 600000;
  return Math.round(number);
}

export function shouldReportClientTiming(random, sample) {
  var rate = sample == null ? CLIENT_TIMING_SAMPLE : Number(sample);
  if (!isFinite(rate) || rate <= 0) return false;
  return Number(random) < rate;
}

export function safeTimingName(value, origin) {
  try {
    var raw = String(value || '');
    var base = origin || '';
    if (!base) {
      if (raw.slice(0, 1) !== '/') return '';
      base = 'null://local';
    }
    var url = new URL(raw, base);
    if (origin && url.origin !== origin) return '';
    var path = url.pathname || '/';
    var version = url.searchParams.get('v') || '';
    if (/^[A-Za-z0-9._-]{1,64}$/.test(version)) return (path + '?v=' + version).slice(0, 180);
    return path.slice(0, 180);
  } catch (_error) {
    return '';
  }
}

export function readNavigationTiming(entry, legacy) {
  if (entry) {
    var tls = entry.secureConnectionStart > 0 ? entry.connectEnd - entry.secureConnectionStart : 0;
    return {
      dns: rounded(entry.domainLookupEnd - entry.domainLookupStart),
      connect: rounded(entry.connectEnd - entry.connectStart),
      tls: rounded(tls),
      ttfb: rounded(entry.responseStart - entry.requestStart),
      download: rounded(entry.responseEnd - entry.responseStart),
      domContentLoaded: rounded(entry.domContentLoadedEventEnd - entry.startTime),
      load: rounded(entry.loadEventEnd > 0 ? entry.loadEventEnd - entry.startTime : 0),
    };
  }
  if (legacy && legacy.navigationStart) {
    var start = legacy.navigationStart;
    return {
      dns: rounded(legacy.domainLookupEnd - legacy.domainLookupStart),
      connect: rounded(legacy.connectEnd - legacy.connectStart),
      tls: rounded(legacy.secureConnectionStart > 0 ? legacy.connectEnd - legacy.secureConnectionStart : 0),
      ttfb: rounded(legacy.responseStart - legacy.requestStart),
      download: rounded(legacy.responseEnd - legacy.responseStart),
      domContentLoaded: rounded(legacy.domContentLoadedEventEnd - start),
      load: rounded((legacy.loadEventEnd || 0) - start),
    };
  }
  return { dns: 0, connect: 0, tls: 0, ttfb: 0, download: 0, domContentLoaded: 0, load: 0 };
}

export function slowTimingResources(entries, origin) {
  var rows = [];
  var list = entries || [];
  for (var index = 0; index < list.length; index += 1) {
    var entry = list[index];
    var name = safeTimingName(entry && entry.name, origin);
    if (!name) continue;
    rows.push({
      name: name,
      type: String((entry && entry.initiatorType) || '').slice(0, 24),
      dur: rounded(entry.duration),
      ttfb: rounded(entry.responseStart > 0 ? entry.responseStart - entry.requestStart : 0),
      size: rounded(entry.transferSize || entry.encodedBodySize || 0),
    });
  }
  rows.sort(function (left, right) { return right.dur - left.dur; });
  return rows.slice(0, 20);
}

export function clientTimingPayload(input) {
  var origin = input && input.origin;
  var resources = slowTimingResources(input && input.resources, origin);
  var navigation = readNavigationTiming(input && input.navigation, input && input.legacy);
  var path = safeTimingName(input && input.href, origin) || '/';
  var payload = '';
  while (resources.length) {
    payload = JSON.stringify({ path: path, nav: navigation, resources: resources });
    if (payload.length <= 3500) return payload;
    resources.pop();
  }
  return JSON.stringify({ path: path, nav: navigation, resources: [] });
}

export function postClientTiming(payload, transport) {
  var body = String(payload || '');
  var fetchImpl = transport && transport.fetch;
  if (typeof fetchImpl === 'function') {
    try {
      var result = fetchImpl(CLIENT_TIMING_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'Content-Type': 'text/plain' },
        body: body,
      });
      if (result && typeof result.catch === 'function') result.catch(function () {});
      return 'fetch';
    } catch (_fetchError) {
      // 继续用 sendBeacon。
    }
  }
  try {
    var sendBeacon = transport && transport.sendBeacon;
    var BlobImpl = transport && transport.Blob;
    if (typeof sendBeacon === 'function' && typeof BlobImpl === 'function') {
      if (sendBeacon(CLIENT_TIMING_ENDPOINT, new BlobImpl([body], { type: 'text/plain' }))) return 'beacon';
    }
  } catch (_beaconError) {
    // 计时上报失败不影响页面。
  }
  return '';
}

export function installClientTiming(win) {
  if (!win || !win.document || win.__aiCenterClientTiming) return;
  win.__aiCenterClientTiming = true;
  var sent = false;
  function report() {
    if (sent || !shouldReportClientTiming(Math.random(), CLIENT_TIMING_SAMPLE)) return;
    sent = true;
    var performance = win.performance;
    var navigation = performance && performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
    var resources = performance && performance.getEntriesByType ? performance.getEntriesByType('resource') : [];
    var payload = clientTimingPayload({
      href: win.location && win.location.href,
      origin: win.location && win.location.origin,
      navigation: navigation,
      legacy: performance && performance.timing,
      resources: resources,
    });
    postClientTiming(payload, {
      fetch: typeof win.fetch === 'function' ? win.fetch.bind(win) : null,
      sendBeacon: win.navigator && win.navigator.sendBeacon ? win.navigator.sendBeacon.bind(win.navigator) : null,
      Blob: win.Blob,
    });
  }
  function schedule() {
    win.setTimeout(report, 0);
  }
  if (win.document.readyState === 'complete') schedule();
  else win.addEventListener('load', schedule);
  win.setTimeout(function () {
    if (!sent) schedule();
  }, 8000);
  win.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    sent = false;
    schedule();
  });
}

if (typeof document !== 'undefined') installClientTiming(globalThis);
