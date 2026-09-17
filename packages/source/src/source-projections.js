function compactQuote({ symbol, name, lastPrice, change, changePct, currency, session, asOf, group, assetClass, market, summary }) {
  return {
    symbol, name, lastPrice, change, changePct, currency, session, asOf,
    ...(group ? { group } : {}),
    ...(assetClass ? { assetClass } : {}),
    ...(market ? { market } : {}),
    ...(summary ? { summary } : {}),
  };
}

export function projectOverviewMarketBoardForAI(data = {}) {
  return {
    board: data.board,
    mode: data.mode,
    fetchedAt: data.fetchedAt,
    session: data.session,
    breadth: data.breadth,
    note: data.note,
    sections: (data.sections || []).map((section) => ({
      id: section.id,
      title: section.title,
      session: section.session,
      mode: section.mode,
      breadth: section.breadth,
      indices: (section.indices || []).map(compactQuote),
      gainers: (section.gainers || []).slice(0, 8).map(compactQuote),
      losers: (section.losers || []).slice(0, 8).map(compactQuote),
    })),
  };
}

export function projectGlobalMarketBoardForAI(data = {}) {
  return {
    board: data.board,
    mode: data.mode,
    fetchedAt: data.fetchedAt,
    session: data.session,
    breadth: data.breadth,
    note: data.note,
    groups: data.groups || [],
    indices: (data.indices || []).map(compactQuote),
    watchlist: (data.watchlist || []).map(compactQuote),
    gainers: (data.gainers || []).slice(0, 8).map(compactQuote),
    losers: (data.losers || []).slice(0, 8).map(compactQuote),
  };
}

export function marketBoardAiWarnings(data = {}) {
  const warnings = [];
  if (data.mode && data.mode !== 'live') warnings.push(data.note || '部分行情不可用');
  if (data.board === 'global' && !(data.watchlist || []).length && !(data.indices || []).length) {
    warnings.push('global market board returned no projected instruments');
  }
  return warnings;
}

export function projectMarketBoardForAI(data = {}) {
  if (data.board === 'overview') return projectOverviewMarketBoardForAI(data);
  if (data.board === 'global') return projectGlobalMarketBoardForAI(data);
  return projectGlobalMarketBoardForAI(data);
}
