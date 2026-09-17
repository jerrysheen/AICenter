export const WEB_EVIDENCE_REQUIRED_NOTE = [
  'The user explicitly asked to search the public web,',
  'but this run has not called web.search.',
  '',
  'Call web.search, or clearly say you did not search.',
  'Do not claim that you searched the web unless the tool was actually executed.',
].join('\n');

export const WEB_PROVENANCE_NOTE = [
  'Your draft claims that web.search or web browsing was used,',
  'but no web.search tool call exists in this run.',
  '',
  'Regenerate the answer using only tools that were actually executed.',
  'Never claim to have used a tool that was not called.',
].join('\n');

export const WEB_UNAVAILABLE_PROVENANCE_NOTE = [
  'web.search was attempted but did not return usable public results.',
  '',
  'You may produce a final answer, but you must say the web search was unavailable or inconclusive.',
  'Do not claim that you found or verified current public facts.',
].join('\n');

const EXPLICIT_SEARCH = /帮我搜|搜一下|搜索一下|联网(查|搜|看看)|网上看看|web\s*search|查新闻|帮我查|搜今天|搜下/i;
const CLAIMED_WEB_TOOL = /web\.search|已经联网搜索|已经搜索公开网页|我查了网页|联网查到|通过\s*web\.search|用\s*web\.search/i;
const CLAIMED_WEB_FINDINGS = /查到|搜索结果(显示|表明|里)|公开网页(显示|表明)|网上(查到|搜到)/i;
const ADMITS_UNAVAILABLE = /不可用|无法核实|没有结果|未能检索/i;

export function explicitSearchIntent(message) {
  return EXPLICIT_SEARCH.test(String(message || ''));
}

export function webSearchEvidence(toolCalls = []) {
  const attempts = toolCalls.filter((call) => call.id === 'web.search');
  const succeeded = attempts.some((call) => call.webSearch?.available === true && Number(call.webSearch.resultCount || 0) > 0);
  return {
    attempted: attempts.length > 0,
    succeeded,
  };
}

export function claimsWebSearchUsed(text) {
  return CLAIMED_WEB_TOOL.test(String(text || ''));
}

export function claimsSuccessfulWebFindings(text) {
  const value = String(text || '');
  return CLAIMED_WEB_FINDINGS.test(value) && !ADMITS_UNAVAILABLE.test(value);
}

export function finalAnswerCorrection({
  answer, evidence, explicitWebSearchRequested = false, webSearchAvailable = false,
}) {
  if (explicitWebSearchRequested && webSearchAvailable && !evidence.attempted) {
    return { note: WEB_EVIDENCE_REQUIRED_NOTE, reason: 'missing-web-search' };
  }
  if (!evidence.attempted && claimsWebSearchUsed(answer)) {
    return { note: WEB_PROVENANCE_NOTE, reason: 'fabricated-web-search' };
  }
  if (evidence.attempted && !evidence.succeeded && claimsSuccessfulWebFindings(answer)) {
    return { note: WEB_UNAVAILABLE_PROVENANCE_NOTE, reason: 'claimed-findings-without-results' };
  }
  return null;
}

export function resolveFinalAnswer({
  answer, evidence, remainingModelCalls = 0,
  explicitWebSearchRequested = false, webSearchAvailable = false,
}) {
  const correction = finalAnswerCorrection({
    answer, evidence, explicitWebSearchRequested, webSearchAvailable,
  });
  if (!correction) return { action: 'accept', answer };
  if (remainingModelCalls > 0) {
    return { action: 'correct', correction: correction.note, reason: correction.reason };
  }
  return { action: 'fail', reason: correction.reason };
}
