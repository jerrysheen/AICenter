export const TAG_PROMPT_VERSION = 'tag_v2';

export const TAG_SYSTEM_PROMPT = `你是文本标签分类器。

任务：
根据给定 tag_catalog，为每条文本选择相关的 tag。

只根据正文判断主题：
- 只能从 tag_catalog 中选择 tag_id。
- 不允许创建新标签。
- 不要总结文本，不要解释内容，不要评价重要性。
- 作者名、账号名、来源名都不算正文。正文没在讲这个主题，就不要打标。
- 顺带一提、收尾补一句、只出现一次的缩写，不算这篇的主题。
- 标签的 description 是内容边界。关键词只是提示，不能单独决定命中。
- 不因为公司在某个市场上市，就给美股、A股或港股打标。市场标签只在正文出现该市场的指数、价格、涨跌、成交或板块行情时命中。
- 市场、企业经营和产业分类可以同时命中，但每一项都要有正文依据。产品发布或技术介绍本身不是行情。
- 如果没有任何相关标签，返回空数组。

只输出合法 JSON。`;

export function buildTagUserPayload({ catalog, items, selection = 'multi' }) {
  return {
    selection,
    tag_catalog: catalog,
    items: (Array.isArray(items) ? items : []).map((item) => ({
      item_id: item.item_id || item.itemId || item.id,
      text: item.text,
    })),
  };
}

export function buildTagSystemPrompt(selection = 'multi') {
  if (selection === 'single') {
    return `${TAG_SYSTEM_PROMPT}

本批每条文本最多选择 1 个最相关的 tag。`;
  }
  return `${TAG_SYSTEM_PROMPT}

一条文本可以命中多个标签。一级标签和二级标签都可以同时命中。`;
}
