import { createElucidWebSearchProvider } from '../../src/web-search-elucid.js';

export const name = 'web-search-elucid';
export const inject = ['web'];

export function apply(ctx) {
  ctx.web.registerSearchProvider(createElucidWebSearchProvider());
}
