/**
 * Host-layer Tool visibility. Shared by Harness and the local fallback loop.
 * Keep this out of agent-runtime.js so production Harness never imports the
 * legacy in-process Agent loop.
 */

export function toolsVisibleForWebMode(tools, webMode = 'off') {
  const mode = webMode === 'always' || webMode === 'fallback' ? webMode : 'off';
  return tools.flatMap((tool) => {
    if (tool.id !== 'web.search') return [tool];
    if (mode === 'off') return [];
    const description = mode === 'always'
      ? '搜索公开互联网网页。不要用它代替本地 Feed、Tag、Knowledge、持仓等已经存在的本地数据源。用户允许并倾向在有帮助时使用，但不是必须调用。'
      : '搜索公开互联网网页。优先用户指定的本地来源；本地数据不足或确实需要公开互联网事实时再使用。不要用它代替本地 Feed、Tag、Knowledge、持仓。';
    return [{ ...tool, description }];
  });
}

export function toolsVisibleForResearchProfile(tools, researchProfile) {
  const extra = new Set(
    Array.isArray(researchProfile?.extraToolIds)
      ? researchProfile.extraToolIds.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
  );
  return tools.filter((tool) => !tool.researchOnly || extra.has(tool.id));
}

export function toolsVisibleForAllowlist(tools, allowedToolIds) {
  if (!Array.isArray(allowedToolIds)) return tools;
  const allow = new Set(allowedToolIds.map((item) => String(item || '').trim()).filter(Boolean));
  return tools.filter((tool) => allow.has(tool.id));
}
