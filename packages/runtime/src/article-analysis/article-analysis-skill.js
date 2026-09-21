export const ARTICLE_ANALYSIS_DOMAIN_TOOL_IDS = Object.freeze([
  'knowledge.search',
  'knowledge.get',
]);

export function articleAnalysisAllowedToolIds(runtime) {
  if (runtime?.kind === 'harness') return ARTICLE_ANALYSIS_DOMAIN_TOOL_IDS;
  return [...ARTICLE_ANALYSIS_DOMAIN_TOOL_IDS, 'web.search'];
}

export const ARTICLE_ANALYSIS_SKILL_INSTRUCTION = [
  '这是 Article Analysis Skill。你在同一次 DeepSeek Harness Run 里阅读材料、按需使用工具，并给出可读分析。',
  '不要把自己当成第二个 Agent，也不要等待程序先分类再分支。',
  '先阅读材料，自己判断主要价值偏 Knowledge、News 还是 Mixed，再按该类自然展开。不要先单独做分类请求，不要返回 JSON，不要启动固定 Workflow。',
  '',
  '### 输出目标',
  '最终输出正常 Markdown，让我不用重读原文，也能理解：这篇材料在讲什么、哪些地方可信、以及值得继续追什么。',
  '不要返回 JSON。不要输出数据库结构。不要为了填模板制造内容。不要自动写入 Knowledge。不要自动给投资利好/利空结论。',
  '',
  '### Knowledge',
  '主要价值来自可复用的概念、原理、机制、方法、框架、因果关系或思考方式。即使一年后阅读，主要价值仍然成立。',
  '不要机械摘要，也不要填固定模板。文章没有某类内容时不要强行补齐。根据材料实际内容，自然展开：',
  '这篇材料在解决什么问题；作者最核心的结论是什么；最重要的概念是什么；机制是怎么工作的；概念之间是什么关系；作者为什么得到这些结论；哪些是原文明说；哪些是合理推导；哪些地方还没解释清楚；和本地已有知识是否存在值得连接的内容；有哪些值得继续追问的问题。',
  '如果文章自身已经足够，不强制调用 Tool。',
  '如果本地知识可能明显帮助理解，可以 knowledge.search，必要时再 knowledge.get。目的是连接已有认知，不是为了填字段。',
  '',
  '### News',
  '主要价值来自新事件、新数据、新产品、新政策、新声明或新变化。核心问题是 What changed。',
  '自然展开：发生了什么；谁做了什么；最重要的新信息是什么；哪些是直接事实；哪些只是某个人或某机构的说法；哪些是作者判断；哪些是因果推论；哪些是预测。',
  '只有真正影响理解的关键事实才需要联网验证。不要机械把每句话拆成 Claim。',
  '需要核验时，由你自己决定：web_search 找来源，必要时再 web_fetch 阅读正文。不要自己实现网页抓取流程。',
  'Evidence 必须来自 Tool Result，不能用模型记忆冒充搜索结果。',
  '最终说明：哪些信息已有外部证据支持；哪些只能确认“有人这么说”；哪些仍未确认；哪些来源存在冲突。',
  '',
  '### Mixed',
  '如果同时有 Knowledge 与 News，由你自己判断主线，同时保留另一部分。不要因为出现“今天、发布、新产品”等词就强制判 News。',
  '例如一篇新发布的技术文章：News 是“今天发布了新架构”；Knowledge 是“新架构怎么工作、为什么这样设计”。主线可能是机制，发布只是事件；也可能反过来。在同一次阅读里判断，不要先单独请求分类。',
  '',
  '### 工具',
  '本地知识使用 knowledge.search / knowledge.get。公开互联网使用 web_search / web_fetch。',
  'Tool 是能力，不是固定流程。可以不调用任何 Tool。Knowledge 不要求一定查知识库。News 不要求每个事实都搜。',
  'Tool 失败时尽量基于已有材料继续，并明确证据不足。不要写入知识库。',
].join('\n');

export function buildArticleAnalysisMessage({ title, sourceUrl, sourceText } = {}) {
  const lines = [
    '请阅读下面这份材料，按 Article Analysis Skill 给出 Markdown 分析。不要返回 JSON。',
    '',
    title ? `标题：${title}` : '',
    sourceUrl ? `来源：${sourceUrl}` : '',
    '',
    '正文：',
    sourceText,
  ];
  return lines.filter((line, index, all) => line || all[index - 1]).join('\n').trim();
}

export function articleAnalysisSkillInvocation(runtime) {
  return Object.freeze({
    taskInstruction: ARTICLE_ANALYSIS_SKILL_INSTRUCTION,
    allowedToolIds: articleAnalysisAllowedToolIds(runtime),
    webMode: 'always',
    enableAuxiliarySearch: false,
  });
}
