import { CFFEX_PRODUCTS } from './indices.js';

function party(value) {
  return String(value ?? '').trim().padStart(4, '0');
}

export function citicNetShort(rows, partyId = '0018') {
  const target = party(partyId);
  const buckets = new Map(CFFEX_PRODUCTS.map((product) => [product, { long: 0, short: 0, seen: false }]));
  for (const row of rows || []) {
    if (party(row.partyId ?? row.party_id) !== target) continue;
    const product = String(row.product || '').toUpperCase();
    const bucket = buckets.get(product);
    if (!bucket) continue;
    const volume = Number(row.volume);
    if (!Number.isFinite(volume)) continue;
    const dataType = Number(row.dataType ?? row.data_type);
    if (dataType === 1) bucket.long += volume;
    if (dataType === 2) bucket.short += volume;
    if (dataType === 1 || dataType === 2) bucket.seen = true;
  }
  const result = {};
  for (const [product, bucket] of buckets) {
    result[product] = bucket.seen ? { netShort: bucket.short - bucket.long, long: bucket.long, short: bucket.short } : null;
  }
  return result;
}

export function citicNetShortChange(today, previous) {
  const change = {};
  for (const product of CFFEX_PRODUCTS) {
    const current = today?.[product]?.netShort;
    const prior = previous?.[product]?.netShort;
    change[product] = Number.isFinite(current) && Number.isFinite(prior) ? current - prior : null;
  }
  return change;
}
