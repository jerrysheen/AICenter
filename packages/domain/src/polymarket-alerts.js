import {
  POLYMARKET_DAY_MS,
  POLYMARKET_DAY_WINDOW_MS,
  POLYMARKET_HOUR_MS,
  POLYMARKET_HOUR_WINDOW_MS,
  selectSeriesProbability,
} from './polymarket-series.js';

function pointKey(row) {
  return `${row.eventId}\0${row.marketId}\0${row.outcomeKey}`;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatPp(delta) {
  return Math.abs(delta).toFixed(1);
}

function moveMessage(windowLabel, delta) {
  const direction = delta >= 0 ? '上升' : '下降';
  return `${windowLabel}${direction} ${formatPp(delta)} 个百分点`;
}

function levelZone(probability, level, hysteresis) {
  const pp = Math.round(probability * 1000);
  const levelPp = Math.round(level * 1000);
  const hystPp = Math.round(hysteresis * 1000);
  if (pp <= levelPp - hystPp) return 'below';
  if (pp >= levelPp + hystPp) return 'above';
  return 'band';
}

function nextLevelState(previous, zone) {
  if (!previous) return { value: zone, alert: null };
  if (zone === 'band') {
    if (previous === 'above' || previous === 'band:above') return { value: 'band:above', alert: null };
    if (previous === 'below' || previous === 'band:below') return { value: 'band:below', alert: null };
    return { value: previous === 'band' ? 'band' : `band:${previous}`, alert: null };
  }
  if (zone === 'above') {
    const fromBelow = previous === 'below' || previous === 'band:below' || previous === 'band';
    return { value: 'above', alert: fromBelow ? 'up' : null };
  }
  const fromAbove = previous === 'above' || previous === 'band:above' || previous === 'band';
  return { value: 'below', alert: fromAbove ? 'down' : null };
}

function cooled(recent, eventId, marketId, alertType, now, cooldownMs) {
  return (recent || []).some((alert) => alert.eventId === eventId
    && alert.marketId === marketId
    && alert.alertType === alertType
    && now - Number(alert.createdAt) < cooldownMs);
}

function stateMap(states) {
  const map = new Map();
  for (const state of states || []) {
    map.set(`${state.eventId}\0${state.marketId}\0${state.outcomeKey}\0${state.stateKey}`, state.stateValue);
  }
  return map;
}

function liveRows(rows) {
  return rows
    .filter((row) => row.lifecycle === 'open' && numberOrNull(row.probability) != null)
    .sort((left, right) => Number(right.probability) - Number(left.probability));
}

export function evaluatePolymarketAlerts({
  outcomes = [],
  points = [],
  states = [],
  recentAlerts = [],
  config,
  now,
}) {
  const profiles = config?.alerts?.profiles;
  if (!profiles) return { alerts: [], states: [] };
  const at = Math.trunc(Number(now));
  const illiquidUsd = Number(config.alerts.illiquidLiquidityUsd) || 0;
  const cooldownMs = (Number(config.alerts.cooldownMinutes) || 60) * 60_000;
  const pointsByKey = new Map();
  for (const point of points) {
    const key = pointKey(point);
    const list = pointsByKey.get(key) || [];
    list.push(point);
    pointsByKey.set(key, list);
  }
  const known = stateMap(states);
  const nextStates = [];
  const alerts = [];
  const grouped = new Map();
  for (const row of outcomes) {
    if (!row?.watched || row.lifecycle === 'closed') continue;
    const list = grouped.get(row.eventId) || [];
    list.push(row);
    grouped.set(row.eventId, list);
  }

  function remember(eventId, marketId, outcomeKey, stateKey, stateValue) {
    const id = `${eventId}\0${marketId}\0${outcomeKey}\0${stateKey}`;
    if (known.get(id) === stateValue) return;
    known.set(id, stateValue);
    nextStates.push({ eventId, marketId, outcomeKey, stateKey, stateValue, updatedAt: at });
  }

  function emit(eventId, marketId, outcomeKey, alertType, message) {
    if (cooled(recentAlerts, eventId, marketId, alertType, at, cooldownMs)) return;
    if (alerts.some((alert) => alert.eventId === eventId && alert.marketId === marketId && alert.alertType === alertType && alert.message === message)) return;
    alerts.push({
      eventId,
      marketId,
      outcomeKey,
      alertType,
      message: String(message).slice(0, 120),
      createdAt: at,
    });
  }

  for (const rows of grouped.values()) {
    const profile = profiles[rows[0].alertProfile] || profiles.binary;
    if (!profile) continue;
    const ranked = liveRows(rows);
    const leader = ranked[0];
    if (!leader) continue;
    const tracked = profile.leadChange || ranked.length > 1 ? leader : ranked[0];
    const liquidity = numberOrNull(tracked.liquidity);
    const illiquid = liquidity != null && liquidity < illiquidUsd;
    const history = pointsByKey.get(pointKey(tracked)) || [];
    const current = Number(tracked.probability);

    if (profile.move1hPp) {
      const prior = numberOrNull(selectSeriesProbability(history, at, POLYMARKET_HOUR_MS, POLYMARKET_HOUR_WINDOW_MS));
      if (prior != null && !illiquid) {
        const delta = (current - prior) * 100;
        if (Math.abs(delta) >= profile.move1hPp) emit(tracked.eventId, tracked.marketId, tracked.outcomeKey, 'move_1h', moveMessage('1 小时', delta));
      }
    }
    if (profile.move24hPp) {
      const prior = numberOrNull(selectSeriesProbability(history, at, POLYMARKET_DAY_MS, POLYMARKET_DAY_WINDOW_MS));
      if (prior != null && !illiquid) {
        const delta = (current - prior) * 100;
        if (Math.abs(delta) >= profile.move24hPp) emit(tracked.eventId, tracked.marketId, tracked.outcomeKey, 'move_24h', moveMessage('24 小时', delta));
      }
    }
    const hysteresis = (Number(profile.hysteresisPp) || 1) / 100;
    for (const level of profile.levels || []) {
      const zone = levelZone(current, level, hysteresis);
      const key = `level:${level}`;
      const previous = known.get(`${tracked.eventId}\0${tracked.marketId}\0${tracked.outcomeKey}\0${key}`) || '';
      const step = nextLevelState(previous, zone);
      remember(tracked.eventId, tracked.marketId, tracked.outcomeKey, key, step.value);
      if (step.alert && !illiquid) {
        emit(tracked.eventId, tracked.marketId, tracked.outcomeKey, 'level_cross', `概率越过 ${Math.round(level * 100)}%`);
      }
    }
    if (profile.leadChange) {
      const identity = `${leader.marketId}\t${leader.outcomeKey}`;
      const previous = known.get(`${leader.eventId}\0\0\0lead`) || '';
      remember(leader.eventId, '', '', 'lead', identity);
      if (previous && previous !== identity && !illiquid) {
        emit(leader.eventId, '', leader.outcomeKey, 'lead_change', `领先结果变为 ${leader.outcomeLabel}`);
      }
    }
  }
  return { alerts, states: nextStates };
}
