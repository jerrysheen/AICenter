export function escapeFts5MatchQuery(query) {
  const tokens = String(query || '')
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^"+|"+$/g, '').trim())
    .filter(Boolean);
  if (!tokens.length) return '';
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
}
