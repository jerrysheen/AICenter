export const HARNESS_WEB_TOOL_IDS = Object.freeze(['web.search', 'web.fetch']);

export const HARNESS_WEB_TOOLS = Object.freeze([
  {
    id: 'web.search',
    name: 'web_search',
    description: '搜索公开互联网。返回来源标题与 URL；需要正文时再用 web_fetch。',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: {
        queries: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    id: 'web.fetch',
    name: 'web_fetch',
    description: '读取指定公开 HTTP(S) 页面正文。用于 web_search 之后细读，或用户已经给出的 URL。',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
    },
  },
]);

export function isHarnessWebToolId(id) {
  return HARNESS_WEB_TOOL_IDS.includes(String(id || ''));
}

export function excludeDomainWebTools(ids = []) {
  return (Array.isArray(ids) ? ids : []).filter((id) => String(id || '') !== 'web.search');
}

export function withHarnessWebTools(catalog = []) {
  const domain = (Array.isArray(catalog) ? catalog : []).filter((tool) => tool?.id !== 'web.search');
  return [...domain, ...HARNESS_WEB_TOOLS];
}
