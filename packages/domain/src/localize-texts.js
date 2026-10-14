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

// A long source with only a short saved translation was cut off. Short posts stay as they are.
export function translationLooksTruncated(source, translatedLength) {
  const body = String(source || '');
  const length = Number(translatedLength) || 0;
  if (body.length < 600 || length <= 0) return false;
  if (length >= 160 && length * 4 >= body.length) return false;
  return length < 120 || length * 5 < body.length;
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
  }
  return units;
}
