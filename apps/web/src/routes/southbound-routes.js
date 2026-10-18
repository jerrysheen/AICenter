import { json } from '../http/response.js';

function daysOf(url) {
  const raw = url.searchParams?.get('days');
  if (raw == null || raw === '') return 20;
  if (!/^\d+$/.test(raw)) return null;
  const days = Number(raw);
  if (days < 1 || days > 60) return null;
  return days;
}

function dateOf(value) {
  const date = String(value || '');
  if (!date) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function boardHandler({ response, services, url }) {
  const days = daysOf(url);
  if (days == null) {
    json(response, 400, { ok: false, error: 'days 需要 1 到 60' });
    return;
  }
  json(response, 200, services.southbound.board(days));
}

function topHandler({ response, services, url }) {
  const code = String(url.searchParams?.get('code') || '').trim();
  const date = dateOf(url.searchParams?.get('date'));
  if (date == null) {
    json(response, 400, { ok: false, error: 'date 需要 YYYY-MM-DD' });
    return;
  }
  if (code) {
    const days = daysOf(url);
    if (days == null) {
      json(response, 400, { ok: false, error: 'days 需要 1 到 60' });
      return;
    }
    json(response, 200, services.southbound.history(code, days));
    return;
  }
  json(response, 200, services.southbound.top10(date));
}

export function createSouthboundRoutes() {
  const paths = ['/api/v1/market/southbound', '/api/market/southbound'];
  const topPaths = ['/api/v1/market/southbound/top10', '/api/market/southbound/top10'];
  return [
    ...paths.map((path) => ({ method: 'GET', path, handler: boardHandler })),
    ...topPaths.map((path) => ({ method: 'GET', path, handler: topHandler })),
  ];
}
