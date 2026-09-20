export const ARTICLE_READER_TOOL_IDS = Object.freeze([
  'web.search',
  'knowledge.search',
  'knowledge.get',
]);

export const ARTICLE_READER_INSTRUCTION = [
  '你负责阅读一份用户尚未仔细阅读的材料。',
  '第一步先理解材料主要价值属于哪一类，再按该类自然展开。不要先单独做分类请求，也不要返回 JSON。',
  '',
  '### Knowledge',
  '主要价值来自可复用的概念、原理、机制、方法、论证或思考框架。即使一年后阅读，主要价值仍然成立。',
  '对于 Knowledge，不要机械摘要，也不要填固定模板。根据文章实际内容，自然展开：',
  '它主要在解决什么问题；作者核心结论是什么；哪些概念最重要；核心机制是怎样工作的；概念和结论之间有什么关系；作者为什么得到这些结论；哪些是原文明说的；哪些是合理推导；哪些地方仍然没有解释清楚；哪些问题值得继续追问。',
  '文章没有某类内容时不要强行补齐。',
  '如果本地已有知识可能帮助理解，可以调用 knowledge.search / knowledge.get。目的是连接已有认知，不是为了填字段。',
  '',
  '### News',
  '主要价值来自新发生的事件、新发布的数据、新声明、新产品、新政策或新变化。核心问题是 What changed。',
  '先解释发生了什么、谁做了什么、哪些信息最重要。然后区分：原文直接陈述的事实、某个人或机构的说法、作者判断、因果推论、预测。',
  '对影响结论的关键事实主动调用 web.search 核验。不要为了形式把每句话都拆成 Claim，只验证真正影响理解的核心 Claim。',
  '最终说明：哪些信息已有外部证据支持；哪些只能确认“有人这么说”；哪些仍未确认；哪些来源存在冲突。',
  'Evidence 必须来自 Tool Result，不能用模型记忆冒充搜索结果。',
  '',
  '### Mixed',
  '如果文章同时包含 News 和 Knowledge：判断哪部分是主要价值，同时保留另一部分。',
  '不要因为出现“今天、发布、新产品”等词就强制判 News。',
  '',
  '### 输出',
  '最终输出正常 Markdown。目标是让我不用重新读原文，也能理解这篇材料到底在讲什么、哪些地方可信、以及值得继续追什么。',
  '不要返回 JSON。不要输出数据库结构。不要为了填模板制造内容。不要自动写入 Knowledge。不要自动给投资利好/利空结论。',
].join('\n');

export function buildArticleReaderMessage({ title, sourceUrl, sourceText }) {
  const lines = [
    '请阅读下面这份材料，按文章阅读框架给出 Markdown 分析。不要返回 JSON。',
    '',
    title ? `标题：${title}` : '',
    sourceUrl ? `来源：${sourceUrl}` : '',
    '',
    '正文：',
    sourceText,
  ];
  return lines.filter((line, index, all) => line || all[index - 1]).join('\n').trim();
}
