export const TAG_PROMPT_VERSION = 'tag_v3';

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
- 市场标签按上市地。正文是在讲这家公司的股票、上市或行情时，按它实际挂牌的市场打标：宁德时代是 A 股，标 market_cn，不要标 market_hk；中国移动若正文在讲其港股，标 market_hk。不要因为公司在别的市场也有名字就改标。
- 产业和主题只标正文明确在讲的内容。公司名、英文短标题、只出现一次的词，都不能单独决定标签。中国移动的正文没有明确写到 AI 算力，就不要标 ai_compute。英文短标题没有明确写到半导体，就不要标 semiconductor。
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

export function buildFeedPreprocessSystem() {
  return `${TAG_SYSTEM_PROMPT}

同时把 original_text 译成简体中文，写入 translated_text。忠实翻译，不要总结、不要扩写、不要加评论。去掉界面残渣和重复空白。保持数字、公司名和专业术语准确。保留原文段落和列表。标签只根据 original_text 原文判断，不要根据译文判断。

一条文本可以命中多个标签。一级标签和二级标签都可以同时命中。`;
}

export function buildFeedPreprocessPayload({ catalog, itemId, originalText }) {
  return {
    selection: 'multi',
    tag_catalog: catalog,
    item_id: itemId,
    original_text: originalText,
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
