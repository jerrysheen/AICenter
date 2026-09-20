const DEFAULT_HOLDINGS_LIMIT = 24;

function text(value, maximum = 1_000) {
  const normalized = String(value || '').trim();
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized;
}

export function projectHoldingPosition(position = {}) {
  const {
    symbol, name, board, quantity, marketValueCny, costCny,
    positionPnlCny, positionPnlPct, dayPnlCny, dayPnlPct, quoteStatus,
  } = position;
  return {
    symbol, name, board, quantity, marketValueCny, costCny,
    positionPnlCny, positionPnlPct, dayPnlCny, dayPnlPct, quoteStatus,
  };
}

export function projectHoldingsBoard(data = {}, { limit = DEFAULT_HOLDINGS_LIMIT, positions } = {}) {
  const source = Array.isArray(positions) ? positions : [...(data.positions || [])]
    .sort((left, right) => Number(right.marketValueCny || 0) - Number(left.marketValueCny || 0));
  const safeLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_HOLDINGS_LIMIT, DEFAULT_HOLDINGS_LIMIT));
  const projected = source.slice(0, safeLimit).map(projectHoldingPosition);
  return {
    summary: data.summary || null,
    portfolios: data.portfolios || [],
    positions: projected,
    returnedCount: projected.length,
    totalCount: source.length,
    truncated: source.length > projected.length,
    moves: data.moves || [],
    moveGroups: data.moveGroups || [],
    missingQuotes: data.missingQuotes || [],
    updatedAt: data.updatedAt || null,
    note: text(data.note, 500),
  };
}

function projectKnowledge(item = {}) {
  return {
    knowledgeId: item.knowledgeId,
    revision: item.revision,
    title: text(item.title, 240),
    snippet: text(item.snippet || item.body, 1_000),
  };
}

function projectFeedItem(item = {}) {
  return {
    id: item.id,
    title: text(item.title, 240),
    summary: text(item.summary || item.body, 1_000),
    authorName: text(item.authorName || item.author, 160),
    sourceUrl: item.sourceUrl || '',
    publishedAt: item.publishedAt || item.createdAt || null,
  };
}

export function projectBuiltContext(contextData = {}) {
  return {
    knowledge: (contextData.knowledge || []).map(projectKnowledge),
    recentFeed: (contextData.recentFeed || []).map(projectFeedItem),
    holdings: contextData.holdings ? projectHoldingsBoard(contextData.holdings) : null,
  };
}

export function projectPersonalAssets(data = {}) {
  return {
    source: data.source,
    currency: data.currency,
    latest: data.latest,
    allocation: data.allocation,
    accounts: (data.accounts || []).map((account) => ({
      typeKey: account.typeKey,
      name: account.name,
      note: account.note,
      displayAmount: account.displayAmount,
      source: account.source,
    })),
    updatedAt: data.updatedAt,
    note: text(data.note, 500),
  };
}
