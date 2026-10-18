const LEADING_BRACKET = /^【([^】\n]{1,80})】\s*/;

function cleanedTitle(value) {
  return String(value || '').trim().replace(/…+$/u, '').replace(/\.{3}$/, '').trim();
}

export function normalizeFlashCopy(title, body) {
  const rawTitle = String(title || '').trim();
  const rawBody = String(body || '').trim();
  const bracket = LEADING_BRACKET.exec(rawBody);
  if (bracket) {
    return { title: bracket[1].trim(), body: rawBody.slice(bracket[0].length).trim() };
  }
  const stripped = cleanedTitle(rawTitle);
  if (!stripped || rawBody.startsWith(stripped)) return { title: '', body: rawBody };
  return { title: rawTitle, body: rawBody };
}
