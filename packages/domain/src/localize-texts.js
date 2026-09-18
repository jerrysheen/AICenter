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
  if (han >= 8 && foreign < Math.max(8, Math.ceil(han * 0.25))) return false;
  return true;
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
