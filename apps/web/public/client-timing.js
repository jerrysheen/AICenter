/* 页面加载完成后抽样上报 Navigation Timing 和最慢的资源。只打本站。 */
(function () {
  var SAMPLE = 0.2;
  var ENDPOINT = '/api/v1/runtime/client-timing';

  function rounded(value) {
    var number = Number(value);
    if (!isFinite(number) || number < 0) return 0;
    if (number > 600000) return 600000;
    return Math.round(number);
  }

  function safeName(value) {
    try {
      var url = new URL(String(value || ''), location.origin);
      if (url.origin !== location.origin) return '';
      var path = url.pathname || '/';
      var version = url.searchParams.get('v') || '';
      if (/^[A-Za-z0-9._-]{1,64}$/.test(version)) return (path + '?v=' + version).slice(0, 180);
      return path.slice(0, 180);
    } catch (_error) {
      return '';
    }
  }

  function navigationTiming(entry) {
    var tls = entry.secureConnectionStart > 0 ? entry.connectEnd - entry.secureConnectionStart : 0;
    return {
      dns: rounded(entry.domainLookupEnd - entry.domainLookupStart),
      connect: rounded(entry.connectEnd - entry.connectStart),
      tls: rounded(tls),
      ttfb: rounded(entry.responseStart - entry.requestStart),
      download: rounded(entry.responseEnd - entry.responseStart),
      domContentLoaded: rounded(entry.domContentLoadedEventEnd - entry.startTime),
      load: rounded(entry.loadEventEnd - entry.startTime),
    };
  }

  function slowResources() {
    var rows = [];
    var entries = performance.getEntriesByType('resource');
    for (var index = 0; index < entries.length; index += 1) {
      var entry = entries[index];
      var name = safeName(entry.name);
      if (!name) continue;
      rows.push({
        name: name,
        type: String(entry.initiatorType || '').slice(0, 24),
        dur: rounded(entry.duration),
        ttfb: rounded(entry.responseStart > 0 ? entry.responseStart - entry.requestStart : 0),
        size: rounded(entry.transferSize || entry.encodedBodySize || 0),
      });
    }
    rows.sort(function (left, right) { return right.dur - left.dur; });
    return rows.slice(0, 20);
  }

  function payloadFor(navigation) {
    var resources = slowResources();
    var payload = '';
    while (resources.length) {
      payload = JSON.stringify({
        path: safeName(location.href) || '/',
        nav: navigationTiming(navigation),
        resources: resources,
      });
      if (payload.length <= 3500) return payload;
      resources.pop();
    }
    return JSON.stringify({
      path: safeName(location.href) || '/',
      nav: navigationTiming(navigation),
      resources: [],
    });
  }

  function send() {
    if (Math.random() >= SAMPLE) return;
    var navigation = performance.getEntriesByType('navigation')[0];
    if (!navigation) return;
    var payload = payloadFor(navigation);
    // text/plain 属于 sendBeacon 的简单请求类型。JSON 媒体类型会在返回 true 后被浏览器丢掉。
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([payload], { type: 'text/plain;charset=UTF-8' });
        if (navigator.sendBeacon(ENDPOINT, blob)) return;
      }
    } catch (_beaconError) {
      // 继续用 fetch。
    }
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: payload,
      }).catch(function () {});
    } catch (_fetchError) {
      // 计时上报失败不影响页面。
    }
  }

  var sent = false;
  function schedule() {
    if (sent) return;
    sent = true;
    window.setTimeout(send, 0);
  }

  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule);
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    sent = false;
    schedule();
  });
})();
