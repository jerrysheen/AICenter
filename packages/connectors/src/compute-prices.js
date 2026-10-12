export const COMPUTE_PRICE_PARSER_VERSION = 'compute-prices-2';
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const RUNPOD_GPU_URL = 'https://api.runpod.io/graphql';
export const VAST_BUNDLES_URL = 'https://console.vast.ai/api/v0/bundles/';

export const CURATED_TOKEN_SELECTORS = [
  { key: 'gpt-flagship', label: 'GPT', pattern: /^openai\/gpt-(?!.*(?:mini|nano|oss|chat))[^:~]+$/ },
  { key: 'gpt-mini', label: 'GPT mini', pattern: /^openai\/gpt-[^:~]*mini[^:~]*$/ },
  { key: 'claude-opus', label: 'Claude Opus', pattern: /^anthropic\/claude-opus-[^:~]+$/ },
  { key: 'claude-sonnet', label: 'Claude Sonnet', pattern: /^anthropic\/claude-sonnet-[^:~]+$/ },
  { key: 'claude-haiku', label: 'Claude Haiku', pattern: /^anthropic\/claude-haiku-[^:~]+$/ },
  { key: 'gemini-pro', label: 'Gemini Pro', pattern: /^google\/gemini-[^:~]*pro[^:~]*$/ },
  { key: 'gemini-flash', label: 'Gemini Flash', pattern: /^google\/gemini-[^:~]*flash[^:~]*$/ },
  { key: 'deepseek', label: 'DeepSeek', pattern: /^deepseek\/deepseek-[^:~]+$/ },
  { key: 'grok', label: 'Grok', pattern: /^x-ai\/grok-[^:~]+$/ },
  { key: 'llama', label: 'Llama', pattern: /^meta-llama\/llama-(?!guard)[^:~]+$/ },
];

export const GPU_PRICE_FLOORS = Object.freeze({
  h100: '1',
  h200: '1.5',
  b200: '2',
  b300: '2.5',
  a100: '0.4',
});

const GPU_FAMILY = [
  { family: 'h100', pattern: /H100/i },
  { family: 'h200', pattern: /H200/i },
  { family: 'b200', pattern: /\bB200\b/i },
];

export function gpuPriceFamily(text) {
  const value = String(text || '');
  if (/MIG/i.test(value)) return null;
  if (/\bB300\b/i.test(value)) return 'b300';
  if (/\bB200\b/i.test(value)) return 'b200';
  if (/H200/i.test(value)) return 'h200';
  if (/H100/i.test(value)) return 'h100';
  if (/A100/i.test(value)) return 'a100';
  return null;
}

const NON_TEXT_ID = /(?:-image|-audio|-tts|-video|preview-image|image-preview|(?:^|[/:])(?:image|audio|tts)(?:$|[/:]))/i;
const NON_TEXT_NAME = /\b(?:image|audio|video|tts|speech)\b/i;
const VAST_H100_NAMES = ['H100 SXM', 'H100 NVL', 'H100 PCIE'];
const RUNPOD_GPU_QUERY = `query {
  gpuTypes {
    id
    displayName
    securePrice
    communityPrice
    lowestPrice(input: { gpuCount: 1 }) { stockStatus uninterruptablePrice }
    secure: lowestPrice(input: { gpuCount: 1, secureCloud: true }) { stockStatus uninterruptablePrice }
    community: lowestPrice(input: { gpuCount: 1, secureCloud: false }) { stockStatus uninterruptablePrice }
  }
}`;

export function usdPerMillionTokens(raw) {
  const text = String(raw ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  const digits = `${whole}${frac}`.replace(/^0+/, '') || '0';
  if (digits === '0') return '0';
  const exp = 6 - frac.length;
  if (exp >= 0) return digits + '0'.repeat(exp);
  const index = digits.length + exp;
  if (index <= 0) return `0.${'0'.repeat(-index)}${digits}`;
  return `${digits.slice(0, index)}.${digits.slice(index)}`;
}

export function decimalFromNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  const text = number.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) ? text : null;
}

function compareDecimal(left, right) {
  const scale = Math.max(fractionLength(left), fractionLength(right));
  const a = scaleDecimal(left, scale);
  const b = scaleDecimal(right, scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

function fractionLength(value) {
  return value.split('.')[1]?.length || 0;
}

function scaleDecimal(value, scale) {
  const [whole, frac = ''] = value.split('.');
  return BigInt(whole) * (10n ** BigInt(scale)) + BigInt((frac + '0'.repeat(scale)).slice(0, scale));
}

function averageDecimal(left, right) {
  const scale = Math.max(fractionLength(left), fractionLength(right)) + 1;
  const sum = scaleDecimal(left, scale) + scaleDecimal(right, scale);
  const half = sum / 2n;
  const unit = 10n ** BigInt(scale);
  const whole = half / unit;
  const frac = String(half % unit).padStart(scale, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

export function medianDecimal(values) {
  const sorted = [...values].filter(Boolean).sort(compareDecimal);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return averageDecimal(sorted[mid - 1], sorted[mid]);
}

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function positiveContext(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function isTextChatModel(model) {
  const id = String(model?.id || '');
  const name = String(model?.name || '');
  if (NON_TEXT_ID.test(id) || NON_TEXT_NAME.test(name)) return false;
  const modalities = model?.architecture?.output_modalities;
  if (!Array.isArray(modalities) || !modalities.length) return false;
  return modalities.every((item) => String(item).toLowerCase() === 'text');
}

export function selectCuratedTokenModels(payload) {
  const models = Array.isArray(payload?.data) ? payload.data : [];
  const warnings = [];
  const rows = [];
  CURATED_TOKEN_SELECTORS.forEach((selector, sortIndex) => {
    const matches = models.filter((model) => selector.pattern.test(String(model?.id || '')) && isTextChatModel(model));
    matches.sort((left, right) => (Number(right?.created) || 0) - (Number(left?.created) || 0) || String(left.id).localeCompare(String(right.id)));
    const chosen = matches.find((model) => {
      const prompt = usdPerMillionTokens(model?.pricing?.prompt);
      const completion = usdPerMillionTokens(model?.pricing?.completion);
      return prompt && completion;
    });
    if (!chosen) {
      warnings.push(`${selector.label} 没有可计价的公开型号`);
      return;
    }
    const name = String(chosen.name || selector.label).replace(/\s+/g, ' ').trim().slice(0, 200) || selector.label;
    rows.push({
      sortIndex,
      modelKey: selector.key,
      modelId: String(chosen.id).slice(0, 200),
      name,
      promptPerMillion: usdPerMillionTokens(chosen.pricing.prompt),
      completionPerMillion: usdPerMillionTokens(chosen.pricing.completion),
      contextLength: positiveContext(chosen.context_length),
    });
  });
  return { rows, warnings };
}

function gpuFamily(row) {
  const text = `${row?.id || ''} ${row?.displayName || ''}`;
  if (/MIG/i.test(text)) return null;
  return GPU_FAMILY.find((item) => item.pattern.test(text)) || null;
}

function stockQuotesPresent(row) {
  return [row?.lowestPrice, row?.secure, row?.community].some((item) => item && typeof item === 'object');
}

function inStockStatus(value) {
  const text = value == null ? '' : String(value).trim().toLowerCase();
  return text === 'high' || text === 'medium' || text === 'low';
}

function laneStockReason(row, lane, price) {
  if (!stockQuotesPresent(row)) return null;
  const tier = lane === 'secure' ? row?.secure : row?.community;
  if (tier && typeof tier === 'object' && inStockStatus(tier.stockStatus)) return null;
  const unscoped = row?.lowestPrice;
  if (unscoped && typeof unscoped === 'object' && inStockStatus(unscoped.stockStatus)) {
    const listed = decimalFromNumber(unscoped.uninterruptablePrice);
    if (listed && listed === price) return null;
  }
  return '无库存';
}

function belowFamilyCutoff(price, median, floor) {
  if (compareDecimal(price, floor) < 0) return true;
  const scale = Math.max(fractionLength(price), fractionLength(median));
  return scaleDecimal(price, scale) * 10n < scaleDecimal(median, scale) * 4n;
}

export function filterAnomalousGpuPrices(entries) {
  const grouped = new Map();
  for (const row of entries) {
    const list = grouped.get(row.family) || [];
    list.push(row.usdPerHour);
    grouped.set(row.family, list);
  }
  const kept = [];
  const filtered = [];
  for (const row of entries) {
    const median = medianDecimal(grouped.get(row.family));
    const floor = row.floor || GPU_PRICE_FLOORS[row.family];
    if (!median || !floor || belowFamilyCutoff(row.usdPerHour, median, floor)) {
      filtered.push({ label: row.label, lane: row.lane, usdPerHour: row.usdPerHour, reason: '低于同型号中位的 40% 或下限' });
      continue;
    }
    kept.push(row);
  }
  return { kept, filtered };
}

export function selectRunPodGpuRates(payload) {
  const types = Array.isArray(payload?.data?.gpuTypes) ? payload.data.gpuTypes : [];
  const chosen = types.map((row) => ({ row, family: gpuFamily(row) })).filter((item) => item.family);
  chosen.sort((left, right) => GPU_FAMILY.findIndex((item) => item.family === left.family.family) - GPU_FAMILY.findIndex((item) => item.family === right.family.family)
    || String(left.row.displayName || '').localeCompare(String(right.row.displayName || '')));
  const pending = [];
  const filtered = [];
  const seen = new Set();
  for (const item of chosen) {
    const label = String(item.row.displayName || item.row.id || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const gpuKey = slug(label);
    if (!label || !gpuKey || seen.has(gpuKey)) continue;
    seen.add(gpuKey);
    for (const [lane, raw] of [['secure', item.row.securePrice], ['community', item.row.communityPrice]]) {
      const usdPerHour = decimalFromNumber(raw);
      if (!usdPerHour) continue;
      if (usdPerHour === '0') {
        filtered.push({ label, lane, usdPerHour, reason: '价格为 0' });
        continue;
      }
      const reason = laneStockReason(item.row, lane, usdPerHour);
      if (reason) {
        filtered.push({ label, lane, usdPerHour, reason });
        continue;
      }
      pending.push({ family: item.family.family, floor: GPU_PRICE_FLOORS[item.family.family], gpuKey, label, lane, usdPerHour });
    }
  }
  const priced = filterAnomalousGpuPrices(pending);
  filtered.push(...priced.filtered);
  const rows = priced.kept.map((row, sortIndex) => ({
    sortIndex,
    gpuKey: row.gpuKey,
    label: row.label,
    lane: row.lane,
    usdPerHour: row.usdPerHour,
    sampleCount: null,
  }));
  return { rows, warnings: rows.length ? [] : ['公开目录里没有 H100、H200 或 B200 小时价'], filtered };
}

function perGpuHour(offer) {
  const count = Number(offer?.num_gpus);
  const fraction = offer?.gpu_frac == null ? 1 : Number(offer.gpu_frac);
  if (!Number.isInteger(count) || count < 1 || count > 64) return null;
  if (!Number.isFinite(fraction) || Math.abs(fraction - 1) > 0.001) return null;
  const total = decimalFromNumber(offer?.dph_total);
  if (!total || total === '0') return null;
  if (count === 1) return total;
  const scale = fractionLength(total);
  const unit = 10n ** BigInt(scale);
  const [whole, frac = ''] = total.split('.');
  const scaled = BigInt(whole) * unit + BigInt((frac + '0'.repeat(scale)).slice(0, scale));
  const each = scaled / BigInt(count);
  const wholeOut = each / unit;
  const fracOut = String(each % unit).padStart(scale, '0').replace(/0+$/, '');
  return fracOut ? `${wholeOut}.${fracOut}` : String(wholeOut);
}

function acceptedVastOffer(offer) {
  const verification = offer?.verification;
  if (verification == null || String(verification).trim() === '') return true;
  const text = String(verification).trim().toLowerCase();
  return text === 'verified' || text === 'unverified';
}

export function selectVastH100Rates(payload) {
  const offers = Array.isArray(payload?.offers) ? payload.offers : [];
  const hours = offers
    .filter((offer) => acceptedVastOffer(offer) && /H100/i.test(String(offer?.gpu_name || '')) && !/H200|B200/i.test(String(offer?.gpu_name || '')))
    .map(perGpuHour)
    .filter(Boolean);
  if (hours.length < 3) {
    const warning = hours.length
      ? `H100 公开挂牌只有 ${hours.length} 条，少于 3 条，不展示`
      : '公开挂牌里没有 H100';
    return { rows: [], warnings: [warning] };
  }
  const low = [...hours].sort(compareDecimal)[0];
  const mid = medianDecimal(hours);
  return {
    rows: [
      { sortIndex: 0, gpuKey: 'h100', label: 'H100', lane: 'min', usdPerHour: low, sampleCount: hours.length },
      { sortIndex: 1, gpuKey: 'h100', label: 'H100', lane: 'median', usdPerHour: mid, sampleCount: hours.length },
    ],
    warnings: [],
  };
}

async function readJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    const host = new URL(url).host;
    throw new Error(`${host} ${response.status}`);
  }
  return response.json();
}

export async function fetchOpenRouterTokenPrices({ fetch: fetchImpl = fetch } = {}) {
  const payload = await readJson(fetchImpl, OPENROUTER_MODELS_URL, { headers: { accept: 'application/json' } });
  return selectCuratedTokenModels(payload);
}

export async function fetchRunPodGpuRates({ fetch: fetchImpl = fetch } = {}) {
  const payload = await readJson(fetchImpl, RUNPOD_GPU_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ query: RUNPOD_GPU_QUERY }),
  });
  return selectRunPodGpuRates(payload);
}

function vastOfferKey(offer) {
  if (offer?.id != null && offer.id !== '') return `id:${offer.id}`;
  if (offer?.ask_contract_id != null && offer.ask_contract_id !== '') return `ask:${offer.ask_contract_id}`;
  return null;
}

export async function fetchVastH100Rates({ fetch: fetchImpl = fetch } = {}) {
  const offers = [];
  const seen = new Set();
  const errors = [];
  for (const name of VAST_H100_NAMES) {
    try {
      const payload = await readJson(fetchImpl, VAST_BUNDLES_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          gpu_name: { eq: name },
          num_gpus: { gte: 1 },
          limit: 500,
          order: [['dph_total', 'asc']],
          type: 'ondemand',
        }),
      });
      for (const offer of Array.isArray(payload?.offers) ? payload.offers : []) {
        const key = vastOfferKey(offer);
        if (key) {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        offers.push(offer);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (!offers.length && errors.length) throw errors[0];
  return selectVastH100Rates({ offers });
}
