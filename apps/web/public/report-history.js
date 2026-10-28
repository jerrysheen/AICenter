function clockHour(value) {
  return Number.isInteger(value) && value >= 0 && value <= 23 ? value : null;
}

function text(value) {
  return String(value || '');
}

export function reportHistoryAction(previous = {}, next = {}) {
  const sameHour = clockHour(previous.hour) === clockHour(next.hour);
  const sameDate = text(previous.date) === text(next.date);
  const sameNode = text(previous.node) === text(next.node);
  if (sameHour && sameDate && sameNode) return 'skip';
  if (!sameHour || !sameDate) return 'push';
  // 同一小时里第一次打开一条，要留下简报列表。再换一条才替换当前这条。
  if (!text(previous.node) && text(next.node)) return 'push';
  return 'replace';
}

export function reportModeHash(currentHash, mode) {
  const raw = String(currentHash || '#report').replace(/^#/, '');
  const [path] = raw.split('?');
  const safe = path.startsWith('report') ? path : 'report';
  if (mode === 'daily' || mode === 'hourly' || mode === 'discussion') return `#${safe}?mode=${mode}`;
  return `#${safe}`;
}

export function reportListHash(detailHash) {
  const raw = String(detailHash || '').replace(/^#/, '');
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  params.delete('node');
  const rest = params.toString();
  return `#${path}${rest ? `?${rest}` : ''}`;
}

export function reportViewOwnsScroll(view, hasHourScroll) {
  return view === 'report' && hasHourScroll === true;
}

export function commitReportHistory({ previous, next, hash, location, history } = {}) {
  const action = reportHistoryAction(previous, next);
  if (action === 'skip' || !hash || !location || location.hash === hash) return 'skip';
  const current = String(location.hash || '');
  // 已经离开简报时，不要改掉详情页那一条历史。
  if (current && !current.startsWith('#report')) return 'skip';
  const write = action === 'push' ? history?.pushState : history?.replaceState;
  if (typeof write !== 'function') return 'skip';
  const entry = { aiCenter: true, hash };
  if (action === 'push' && !text(previous?.node) && text(next?.node)) {
    entry.aiCenterReportList = true;
    entry.aiCenterPrevious = current;
  }
  try {
    write.call(history, entry, '', `${location.pathname || ''}${location.search || ''}${hash}`);
  } catch {
    return 'skip';
  }
  return action;
}

export function stackReportNode({ history, location, listHash, detailHash } = {}) {
  if (!history || !location || !detailHash || !listHash || detailHash === listHash) return 'skip';
  if (history.state?.aiCenterReportList) return 'skip';
  const current = String(location.hash || '');
  if (current && !current.startsWith('#report') && current !== detailHash) return 'skip';
  const replace = history.replaceState;
  const push = history.pushState;
  if (typeof replace !== 'function' || typeof push !== 'function') return 'skip';
  const previous = history.state?.aiCenterPrevious || '';
  const base = `${location.pathname || ''}${location.search || ''}`;
  try {
    replace.call(history, {
      aiCenter: true,
      hash: listHash,
      ...(previous ? { aiCenterPrevious: previous } : {}),
    }, '', `${base}${listHash}`);
    push.call(history, {
      aiCenter: true,
      hash: detailHash,
      aiCenterReportList: true,
      aiCenterPrevious: listHash,
    }, '', `${base}${detailHash}`);
  } catch {
    return 'skip';
  }
  return 'stacked';
}
