const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

export function cffexPositionUrl(product, tradeDate) {
  const [year, month, day] = String(tradeDate).split('-');
  return `http://www.cffex.com.cn/sj/ccpm/${year}${month}/${day}/${product}.xml`;
}

function tagText(block, names) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
    if (match) return match[1].replace(/<[^>]+>/g, '').trim();
  }
  return '';
}

function blocks(xml, tag) {
  return [...String(xml).matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((match) => match[1]);
}

export function parseCffexPositionXml(xml, { product, tradeDate, sourceUrl = '' } = {}) {
  const text = String(xml || '').replace(/^\uFEFF/, '');
  let chunks = blocks(text, 'data');
  if (!chunks.length) chunks = blocks(text, 'row');
  const rows = [];
  for (const chunk of chunks) {
    const partyId = tagText(chunk, ['partyid', 'partyId', 'party_id']);
    const rank = Number(tagText(chunk, ['rank']));
    const volume = Number(String(tagText(chunk, ['volume'])).replaceAll(',', ''));
    const dataType = Number(tagText(chunk, ['dataTypeId', 'datatypeid', 'dataType', 'datatype']));
    const contract = tagText(chunk, ['instrumentId', 'instrumentid', 'contract', 'instrument']);
    const member = tagText(chunk, ['shortname', 'shortName', 'participantabbr']);
    const varVolume = Number(String(tagText(chunk, ['varVolume', 'varvolume', 'var_volume'])).replaceAll(',', ''));
    const rowDate = tagText(chunk, ['tradingDay', 'tradingday']);
    if (!partyId || !contract || !Number.isInteger(rank) || !Number.isFinite(volume)) continue;
    if (![0, 1, 2].includes(dataType)) continue;
    const normalizedDate = /^\d{8}$/.test(rowDate)
      ? `${rowDate.slice(0, 4)}-${rowDate.slice(4, 6)}-${rowDate.slice(6, 8)}`
      : (tradeDate || '');
    rows.push({
      tradeDate: normalizedDate,
      product: String(product || contract.replace(/\d.*/, '')).toUpperCase(),
      contract,
      dataType,
      rank,
      partyId: partyId.padStart(4, '0'),
      member: member || partyId,
      volume,
      varVolume: Number.isFinite(varVolume) ? varVolume : null,
      sourceUrl,
    });
  }
  return rows;
}

export async function fetchCffexPosition(product, tradeDate, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = cffexPositionUrl(product, tradeDate);
  const started = Date.now();
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: 'http://www.cffex.com.cn/' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    const body = Buffer.from(await response.arrayBuffer());
    const probe = {
      source: 'cffex',
      url,
      product,
      tradeDate,
      status: response.status,
      bytes: body.length,
      ms: Date.now() - started,
      error: response.ok ? '' : `HTTP ${response.status}`,
      rowCount: 0,
    };
    if (!response.ok) return { ok: false, rows: [], probes: [probe], body, error: probe.error };
    const rows = parseCffexPositionXml(body.toString('latin1'), { product, tradeDate, sourceUrl: url });
    probe.rowCount = rows.length;
    return { ok: rows.length > 0, rows, probes: [probe], body, error: rows.length ? '' : '中金所持仓为空' };
  } catch (error) {
    return {
      ok: false,
      rows: [],
      probes: [{ source: 'cffex', url, product, tradeDate, status: 0, error: error.message || String(error), rowCount: 0 }],
      body: Buffer.alloc(0),
      error: error.message || String(error),
    };
  }
}
