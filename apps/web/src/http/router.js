import { json } from './response.js';

function matchRoute(pattern, pathname) {
  if (typeof pattern === 'string') return pattern === pathname ? {} : null;
  const match = pathname.match(pattern);
  return match ? { match, values: match.slice(1) } : null;
}

export function createRouter(routes) {
  return Object.freeze({
    async dispatch(context) {
      for (const route of routes) {
        if (route.method !== context.request.method) continue;
        const params = matchRoute(route.path, context.url.pathname);
        if (!params) continue;

        const access = route.access || 'authenticated';
        if (!['public', 'desktop-public'].includes(access) && !context.identity) {
          json(context.response, 401, { ok: false, error: '此设备尚未配对' });
          return true;
        }
        if (['desktop', 'desktop-public'].includes(access) && context.identity?.kind !== 'desktop') {
          json(context.response, 403, { ok: false, error: route.forbidden || '此操作仅在本机开放' });
          return true;
        }
        await route.handler({ ...context, params });
        return true;
      }
      return false;
    },
  });
}
