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

export function cffexMissingPage(text, finalUrl = '') {
  const body = String(text || '');
  const url = String(finalUrl || '');
  if (/error_404/i.test(url) || /error_404/i.test(body)) return true;
  if (/<!doctype html/i.test(body) && !/<positionRank\b/i.test(body) && !/<instrumentid\b/i.test(body)) return true;
  return false;
}

async function readCffexBody(response, timeoutMs) {
  let timer;
  try {
    return Buffer.from(await Promise.race([
      response.arrayBuffer(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]));
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCffexPosition(product, tradeDate, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = cffexPositionUrl(product, tradeDate);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const started = Date.now();
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: 'http://www.cffex.com.cn/' },
      signal: controller.signal,
    });
    const finalUrl = response.url || url;
    const body = await readCffexBody(response, timeoutMs);
    const probe = {
      source: 'cffex',
      url: finalUrl,
      product,
      tradeDate,
      status: response.status,
      bytes: body.length,
      ms: Date.now() - started,
      error: response.ok ? '' : `HTTP ${response.status}`,
      rowCount: 0,
    };
    if (!response.ok) {
      const missing = response.status === 404 || cffexMissingPage(body.toString('utf8'), finalUrl);
      return { ok: false, missing, rows: [], probes: [probe], body, error: probe.error, finalUrl };
    }
    const utf8 = body.toString('utf8');
    if (cffexMissingPage(utf8, finalUrl) || cffexMissingPage(body.toString('latin1'), finalUrl)) {
      probe.error = '中金所无该日持仓文件';
      return { ok: false, missing: true, rows: [], probes: [probe], body, error: probe.error, finalUrl };
    }
    const rows = parseCffexPositionXml(body.toString('latin1'), { product, tradeDate, sourceUrl: url });
    probe.rowCount = rows.length;
    return { ok: rows.length > 0, missing: false, rows, probes: [probe], body, error: rows.length ? '' : '中金所持仓为空', finalUrl };
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'timeout' : (error.message || String(error));
    return {
      ok: false,
      missing: false,
      rows: [],
      probes: [{ source: 'cffex', url, product, tradeDate, status: 0, error: message, rowCount: 0 }],
      body: Buffer.alloc(0),
      error: message,
      finalUrl: url,
    };
  } finally {
    clearTimeout(abortTimer);
  }
}
