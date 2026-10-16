export function monthFromTitle(title, template, months) {
  const text = String(title || '');
  const pattern = String(template || '');
  for (const month of months || []) {
    if (text === pattern.replaceAll('{month}', month)) return month;
  }
  return '';
}

export function nextMonthName(month, months) {
  const names = months || [];
  const index = names.indexOf(month);
  if (index < 0) return '';
  return names[(index + 1) % names.length];
}

export function pendingSeriesEventId(seriesId, month) {
  return `pending:${seriesId}:${month}`.slice(0, 64);
}

export function placeholderSeriesRows(series, month, seed, observedAt) {
  const title = String(series?.titleTemplate || '').replaceAll('{month}', month);
  return [{
    eventId: pendingSeriesEventId(series?.id, month),
    marketId: 'pending',
    outcomeKey: 'pending',
    seriesId: series?.id || '',
    watched: true,
    sortOrder: seed?.sortOrder ?? 800,
    groupKey: seed?.group || series?.id || '',
    alertProfile: seed?.alertProfile || 'multi',
    eventSlug: '',
    marketSlug: '',
    title,
    outcomeLabel: '待定',
    lifecycle: 'pending_rollover',
    endAt: null,
    liquidity: null,
    volume24h: null,
    totalVolume: null,
    probability: null,
    sourceUrl: 'https://polymarket.com',
    updatedAt: observedAt,
    closed: true,
  }];
}

export function pickOpenSeriesEvent(events, template, month) {
  const title = String(template || '').replaceAll('{month}', month);
  const matches = (events || []).filter((event) => event && event.closed !== true && event.id != null && event.title === title);
  matches.sort((left, right) => Date.parse(right.endDate || 0) - Date.parse(left.endDate || 0));
  return matches[0] || null;
}

export function heldSeriesEvents(outcomes, seriesId) {
  const grouped = new Map();
  for (const row of outcomes || []) {
    if (row?.seriesId !== seriesId || row.watched === false) continue;
    const list = grouped.get(row.eventId) || [];
    list.push(row);
    grouped.set(row.eventId, list);
  }
  return [...grouped.entries()].map(([eventId, rows]) => ({
    eventId,
    eventSlug: String(rows[0].eventSlug || ''),
    title: rows[0].title,
    endAt: Math.max(...rows.map((row) => Number(row.endAt) || 0)),
    closed: rows.every((row) => row.lifecycle === 'closed' || row.lifecycle === 'pending_rollover'),
  }));
}

export function rollingWindow(series, held, months, options = {}) {
  const seedSlug = String(options.seedSlug || '');
  const labeled = (held || []).map((event) => ({
    ...event,
    month: monthFromTitle(event.title, series.titleTemplate, months),
  })).filter((event) => event.month);
  labeled.sort((left, right) => left.endAt - right.endAt || String(left.eventId).localeCompare(String(right.eventId)));
  if (!labeled.length) return { keepIds: [], seekMonths: [], pendingIds: [], releaseIds: [] };

  if (Number(series.hold) <= 1) {
    const open = labeled.filter((event) => !event.closed);
    const seedOpen = open.find((event) => seedSlug && event.eventSlug === seedSlug);
    const current = seedOpen || open[open.length - 1];
    if (current) {
      return {
        keepIds: [current.eventId],
        seekMonths: [],
        pendingIds: [],
        releaseIds: labeled.filter((event) => event.eventId !== current.eventId).map((event) => event.eventId),
      };
    }
    const settled = labeled[labeled.length - 1];
    const upcoming = nextMonthName(settled.month, months);
    return {
      keepIds: [],
      seekMonths: upcoming ? [upcoming] : [],
      pendingIds: [settled.eventId],
      releaseIds: labeled.filter((event) => event.eventId !== settled.eventId).map((event) => event.eventId),
    };
  }

  const open = labeled.filter((event) => !event.closed);
  let desired;
  if (open.length) {
    const anchor = open[0];
    const upcoming = nextMonthName(anchor.month, months);
    desired = [anchor.month, upcoming].filter(Boolean);
  } else {
    const settled = labeled[labeled.length - 1];
    const upcoming = nextMonthName(settled.month, months);
    const after = nextMonthName(upcoming, months);
    desired = [upcoming, after].filter(Boolean);
  }
  const keepByMonth = new Map();
  for (const event of open) {
    if (!desired.includes(event.month)) continue;
    const previous = keepByMonth.get(event.month);
    if (!previous || event.endAt >= previous.endAt) keepByMonth.set(event.month, event);
  }
  const keepIds = [...keepByMonth.values()].map((event) => event.eventId);
  const seekMonths = desired.filter((month) => !keepByMonth.has(month));
  const outside = labeled.filter((event) => !keepIds.includes(event.eventId));
  if (!seekMonths.length) {
    return { keepIds, seekMonths, pendingIds: [], releaseIds: outside.map((event) => event.eventId) };
  }
  const settled = outside.filter((event) => event.closed);
  const pendingIds = settled.length ? [settled[settled.length - 1].eventId] : [];
  return {
    keepIds,
    seekMonths,
    pendingIds,
    releaseIds: outside.filter((event) => !pendingIds.includes(event.eventId)).map((event) => event.eventId),
  };
}
