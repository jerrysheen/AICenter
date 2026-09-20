/* 不缓存。打开页面先问界面指纹；不一致则等指纹稳定后再整页换新 HTML/CSS/JS，避免一次改多个文件连刷。 */
(function () {
  var host = location.hostname;
  var privateHost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
    || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
    || host.indexOf('.') < 0;
  if (location.protocol === 'http:' && !privateHost) {
    location.replace('https://' + location.host + location.pathname + location.search + location.hash);
    return;
  }

  var meta = document.querySelector('meta[name="ai-center-ui-revision"]');
  var local = meta ? String(meta.getAttribute('content') || '') : '';
  window.aiCenterUiReloading = false;

  function sleep(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  }

  async function settleRevision(read) {
    var last = await read();
    var stable = 1;
    var intervalMs = 450;
    var stableReads = 3;
    var maxReads = 8;
    for (var i = 1; i < maxReads && stable < stableReads; i += 1) {
      await sleep(intervalMs);
      var next = await read();
      if (next === last) stable += 1;
      else {
        last = next;
        stable = 1;
      }
    }
    return last;
  }

  function applyReload(remote) {
    var url = new URL(window.location.href);
    if (url.searchParams.get('v') === remote) return false;
    try {
      if (sessionStorage.getItem('ai-center.ui-reload') === remote) return false;
      sessionStorage.setItem('ai-center.ui-reload', remote);
    } catch (_error) {
      // 无 sessionStorage 时仍整页更换。
    }
    window.aiCenterUiReloading = true;
    url.searchParams.set('v', remote);
    window.location.replace(url.pathname + url.search + url.hash);
    return true;
  }

  async function fetchRevision(signal) {
    var response = await fetch('/api/v1/ui/revision', {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: signal,
    });
    var payload = await response.json();
    return payload && payload.revision ? String(payload.revision) : '';
  }

  window.aiCenterUiBoot = (async function () {
    if (!local) return { local: '', remote: '', reloading: false };

    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = window.setTimeout(function () {
      if (controller) controller.abort();
    }, 2500);

    try {
      var first = await fetchRevision(controller ? controller.signal : undefined);
      window.clearTimeout(timer);
      if (!first || first === local) return { local: local, remote: first, reloading: false };
      var remote = await settleRevision(function () {
        return fetchRevision();
      });
      if (!remote || remote === local) return { local: local, remote: remote, reloading: false };
      return { local: local, remote: remote, reloading: applyReload(remote) };
    } catch (_error) {
      window.clearTimeout(timer);
      return { local: local, remote: '', reloading: false };
    }
  })();
})();
