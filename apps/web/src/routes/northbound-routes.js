import { json } from '../http/response.js';

function daysOf(url) {
  const raw = url.searchParams?.get('days');
  if (raw == null || raw === '') return 20;
  if (!/^\d+$/.test(raw)) return null;
  const days = Number(raw);
  if (days < 1 || days > 60) return null;
  return days;
}

function boardHandler({ response, services, url }) {
  const days = daysOf(url);
  if (days == null) {
    json(response, 400, { ok: false, error: 'days 需要 1 到 60' });
    return;
  }
  json(response, 200, services.northbound.board(days));
}

export function createNorthboundRoutes() {
  const paths = ['/api/v1/market/northbound', '/api/market/northbound'];
  return paths.map((path) => ({ method: 'GET', path, handler: boardHandler }));
}
