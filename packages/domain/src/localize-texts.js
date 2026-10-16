import { createHash } from 'node:crypto';

function countMatches(source, pattern) {
  return (source.match(pattern) || []).length;
}

export function needsZhLocalization(sourceText) {
  const source = String(sourceText || '').trim();
  if (!source) return false;
  const hangul = countMatches(source, /\p{Script=Hangul}/gu);
  const latin = countMatches(source, /[A-Za-z]/g);
  const han = countMatches(source, /\p{Script=Han}/gu);
  if (hangul === 0 && latin === 0) return false;
  const foreign = hangul + latin;
  if (hangul >= 2 && hangul >= han && hangul >= latin) return true;
  // Twelve Han characters mark a short post or a Han-dominant article as Chinese.
  // A long Latin document that only quotes a few Han characters still needs translation.
  if (han >= 12 && (source.length <= 280 || han * 8 >= foreign)) return false;
  if (han >= 8 && foreign < Math.max(8, Math.ceil(han * 0.25))) return false;
  return latin >= 8 || hangul >= 2;
}

function scriptCounts(value) {
  const text = String(value || '');
  return {
    han: countMatches(text, /\p{Script=Han}/gu),
    latin: countMatches(text, /[A-Za-z]/g),
  };
}

function unmatchedOpens(value) {
  const pairs = [['（', '）'], ['(', ')'], ['[', ']'], ['【', '】'], ['「', '」'], ['『', '』']];
  let extra = 0;
  const text = String(value || '');
  for (const [open, close] of pairs) {
    const opens = text.split(open).length - 1;
    const closes = text.split(close).length - 1;
    if (opens > closes) extra += opens - closes;
  }
  return extra;
}

function stripTrailingClosers(value) {
  return String(value || '').trim().replace(/[\s"'“”‘’」』）】\])]+$/u, '').trim();
}

function titleLikeSource(source) {
  const src = String(source || '').trim();
  return Boolean(src) && src.length <= 240 && !src.includes('\n');
}

// A saved translation that stops at an ellipsis, an unclosed bracket, or before the
// source's final sentence was cut off. A source that itself ends in an ellipsis can
// keep that ending when the length is otherwise healthy. Titles and texts under 80
// characters are not failed for a missing final period.
export function translationEndingCut(source, translated) {
  const src = String(source || '').trim();
  const dst = String(translated || '').trim();
  if (!src || !dst) return false;
  const ellipsis = /(?:\.{3,}|…+)\s*$/u;
  if (ellipsis.test(dst) && !ellipsis.test(src)) return true;
  if (unmatchedOpens(dst) > 0 && unmatchedOpens(src) === 0) return true;
  if (src.length < 80 || titleLikeSource(src)) return false;
  const srcEnd = stripTrailingClosers(src);
  const dstEnd = stripTrailingClosers(dst);
  const terminal = /[。！？.!?]$/u;
  if (terminal.test(srcEnd) && !terminal.test(dstEnd) && !ellipsis.test(dst) && dst.length >= 20) return true;
  return false;
}

// Long sources with a short saved translation were cut off. Bodies under 80
// characters stay put. Latin compresses into Chinese; Han stays nearer one to one.
// Pass the translated string (or its ending) to also catch a cut sentence.
export function translationLooksTruncated(source, translatedLength, translatedText = '') {
  const body = String(source || '');
  const text = String(translatedText || '');
  const length = Number(translatedLength) > 0 ? Number(translatedLength) : text.trim().length;
  if (!body.trim() || length <= 0) return false;
  if (body.length < 80 || titleLikeSource(body)) return text.trim() ? translationEndingCut(body, text) : false;
  if (text.trim() && translationEndingCut(body, text)) return true;
  if (length >= 160 && length * 4 >= body.length) return false;
  if (body.length >= 600) return length < 120 || length * 5 < body.length;
  const { han, latin } = scriptCounts(body);
  const foreign = han + latin;
  const divisor = foreign && han / foreign >= 0.5 ? 1.6 : 4;
  return length * divisor < body.length;
}

export function localizationItemId(id) {
  const value = String(id || '').trim();
  if (!value) return '';
  if (value.length <= 128) return value;
  return `h:${createHash('sha256').update(value).digest('hex')}`;
}

function pushUnit(units, seen, id, text) {
  const sourceId = String(id || '').trim();
  const sourceText = String(text || '').trim();
  if (!sourceId || !sourceText || seen.has(sourceId)) return;
  seen.add(sourceId);
  units.push({
    id: sourceId,
    localizationId: localizationItemId(sourceId),
    text: sourceText,
  });
}

export function collectLocalizationUnits(payload = {}) {
  const units = [];
  const seen = new Set();
  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  for (const event of data.upcoming || data.events || []) {
    pushUnit(units, seen, event.eventId, event.title);
  }
  for (const release of data.releases || []) {
    pushUnit(units, seen, release.releaseId, release.title);
  }
  const quotes = data.predictionMarkets || (data.quotes || []).filter((row) => row?.marketQuestion);
  for (const quote of quotes) {
    pushUnit(units, seen, quote.quoteId, quote.marketQuestion);
    for (const outcome of quote.outcomes || []) {
      pushUnit(units, seen, `${quote.quoteId}:${outcome.label}`, outcome.label);
    }
  }
  return units;
}
