import { buildAgentSystemInstruction } from '../../runtime/src/agent-prompt.js';
import { formatRuntimeContextNote } from '../../runtime/src/runtime-context.js';

function turnLine(turn) {
  const question = String(turn?.inputText || '').trim();
  const answer = String(turn?.outputText || '').trim();
  if (!question && !answer) return '';
  return [
    question && `用户：${question}`,
    answer && `助手：${answer}`,
  ].filter(Boolean).join('\n');
}

const CLOSED_CONTEXT_PROMPT = [
  '本任务是封闭材料任务。',
  '只能依据下方给定材料。',
  '本轮没有开放任何外部工具或互联网能力。',
  '材料没有的信息必须保持未知。',
].join('\n');

export function buildHarnessPrompt({
  message,
  selectedContext = '',
  priorTurns = [],
  webMode = 'off',
  researchProfile,
  taskInstruction = '',
  runtimeContext,
  catalog = [],
  closedContext = false,
} = {}) {
  const history = priorTurns.map(turnLine).filter(Boolean).join('\n\n');
  const question = selectedContext
    ? `${selectedContext}\n\n用户问题：\n${String(message || '')}`
    : String(message || '');
  const toolSection = closedContext
    ? CLOSED_CONTEXT_PROMPT
    : [
      '当前由 DeepSeek Harness 执行。',
      '公开互联网使用内置 web_search / web_fetch（搜索来源，需要整页正文再 fetch）。不要另造 web_read。',
      '本地持仓、知识、信息流、官方信源使用下列 AI Center 工具。',
      '不要调用 shell、文件系统、subagent 或其它 Host 工具。',
      '没有实际调用某个工具，就不能声称调用过。',
      catalog.map((tool) => `- ${tool.id} (${tool.name}): ${tool.description}`).join('\n')
        || '- （本轮没有对 Harness 开放任何工具）',
    ].join('\n');
  return [
    closedContext ? '' : buildAgentSystemInstruction(webMode, researchProfile, { webInfra: 'harness' }),
    String(taskInstruction || '').trim(),
    runtimeContext ? formatRuntimeContextNote(runtimeContext) : '',
    toolSection,
    history && `此前对话：\n${history}`,
    question,
  ].filter(Boolean).join('\n\n');
}
