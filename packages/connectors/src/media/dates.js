const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function numericOffset(value) {
  const match = String(value || '').trim().match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

const NAMED_OFFSETS = {
  ut: 0, utc: 0, gmt: 0, z: 0,
  est: -5 * 60, edt: -4 * 60, cst: -6 * 60, cdt: -5 * 60,
  mst: -7 * 60, mdt: -6 * 60, pst: -8 * 60, pdt: -7 * 60,
};

export function parseFeedDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return { publishedAt: null, publishedAtRaw: '' };
  const iso = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/,
  );
  if (iso) {
    const offset = iso[7] ? (iso[7] === 'Z' ? 0 : numericOffset(iso[7])) : null;
    if (offset == null) return { publishedAt: null, publishedAtRaw: raw };
    const utc = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4]), Number(iso[5]), Number(iso[6] || 0));
    return { publishedAt: utc - offset * 60_000, publishedAtRaw: raw };
  }
  const rfc = raw.match(/^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*([A-Za-z]{2,4}|[+-]\d{4})?$/);
  if (rfc) {
    const month = MONTHS[rfc[2].toLowerCase()];
    if (month == null) return { publishedAt: null, publishedAtRaw: raw };
    const zone = rfc[7] || '';
    const offset = zone
      ? (NAMED_OFFSETS[zone.toLowerCase()] ?? numericOffset(zone.replace(/^([+-])(\d{2})(\d{2})$/, '$1$2:$3')))
      : null;
    if (offset == null) return { publishedAt: null, publishedAtRaw: raw };
    const utc = Date.UTC(Number(rfc[3]), month, Number(rfc[1]), Number(rfc[4]), Number(rfc[5]), Number(rfc[6] || 0));
    return { publishedAt: utc - offset * 60_000, publishedAtRaw: raw };
  }
  return { publishedAt: null, publishedAtRaw: raw };
}
