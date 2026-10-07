import { createElucidWebSearchProvider } from '../../src/web-search-elucid.js';

export const name = 'web-search-elucid';
export const inject = ['web'];

export function apply(ctx) {
  ctx.web.registerSearchProvider(createElucidWebSearchProvider({
    async usageObserver(value) {
      try {
        const url = process.env.AI_CENTER_HARNESS_GATEWAY_URL;
        const token = process.env.AI_CENTER_HARNESS_GATEWAY_TOKEN;
        if (!url || !token) return;
        await fetch(`${url}/usage/observe`, { method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(value), signal: AbortSignal.timeout(1500) });
      } catch {}
    },
  }));
}
