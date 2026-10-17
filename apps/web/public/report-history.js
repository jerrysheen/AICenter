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
  return 'replace';
}

export function reportViewOwnsScroll(view, hasHourScroll) {
  return view === 'report' && hasHourScroll === true;
}

export function commitReportHistory({ previous, next, hash, location, history } = {}) {
  const action = reportHistoryAction(previous, next);
  if (action === 'skip' || !hash || !location || location.hash === hash) return 'skip';
  const write = action === 'push' ? history?.pushState : history?.replaceState;
  if (typeof write !== 'function') return 'skip';
  try {
    write.call(history, { aiCenter: true, hash }, '', `${location.pathname || ''}${location.search || ''}${hash}`);
  } catch {
    return 'skip';
  }
  return action;
}
