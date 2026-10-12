import { isApiTokenAllowlisted } from './api-token-access.js';
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
        if (context.identity?.kind === 'api-token' && !isApiTokenAllowlisted(context.request.method, context.url.pathname)) {
          json(context.response, 401, { ok: false, error: '此令牌只能读取指定的只读接口' });
          return true;
        }
        if (!['public', 'desktop-public'].includes(access) && !context.identity) {
          json(context.response, 401, { ok: false, error: '此设备尚未配对' });
          return true;
        }
        if (access === 'operator' && !['desktop', 'device'].includes(context.identity?.kind)) {
          json(context.response, context.identity ? 403 : 401, { ok: false, error: '只能由已登录的设备管理令牌' });
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
