export const COMPUTE_PRICE_PARSER_VERSION = 'compute-prices-1';
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

const GPU_FAMILY = [
  { family: 'h100', pattern: /H100/i },
  { family: 'h200', pattern: /H200/i },
  { family: 'b200', pattern: /\bB200\b/i },
];

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

export function selectCuratedTokenModels(payload) {
  const models = Array.isArray(payload?.data) ? payload.data : [];
  const warnings = [];
  const rows = [];
  CURATED_TOKEN_SELECTORS.forEach((selector, sortIndex) => {
    const matches = models.filter((model) => selector.pattern.test(String(model?.id || '')));
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
  return GPU_FAMILY.find((item) => item.pattern.test(text))?.family || null;
}

export function selectRunPodGpuRates(payload) {
  const types = Array.isArray(payload?.data?.gpuTypes) ? payload.data.gpuTypes : [];
  const chosen = types.map((row) => ({ row, family: gpuFamily(row) })).filter((item) => item.family);
  chosen.sort((left, right) => GPU_FAMILY.findIndex((item) => item.family === left.family) - GPU_FAMILY.findIndex((item) => item.family === right.family)
    || String(left.row.displayName || '').localeCompare(String(right.row.displayName || '')));
  const rows = [];
  const seen = new Set();
  for (const item of chosen) {
    const label = String(item.row.displayName || item.row.id || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const gpuKey = slug(label);
    if (!label || !gpuKey || seen.has(gpuKey)) continue;
    seen.add(gpuKey);
    const lanes = [
      ['secure', decimalFromNumber(item.row.securePrice)],
      ['community', decimalFromNumber(item.row.communityPrice)],
    ];
    for (const [lane, usdPerHour] of lanes) {
      if (!usdPerHour || usdPerHour === '0') continue;
      rows.push({
        sortIndex: rows.length,
        gpuKey,
        label,
        lane,
        usdPerHour,
        sampleCount: null,
      });
    }
  }
  return { rows, warnings: rows.length ? [] : ['公开目录里没有 H100、H200 或 B200 小时价'] };
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

export function selectVastH100Rates(payload) {
  const offers = Array.isArray(payload?.offers) ? payload.offers : [];
  const hours = offers
    .filter((offer) => /H100/i.test(String(offer?.gpu_name || '')) && !/H200|B200/i.test(String(offer?.gpu_name || '')))
    .map(perGpuHour)
    .filter(Boolean);
  if (!hours.length) return { rows: [], warnings: ['公开挂牌里没有 H100'] };
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
    body: JSON.stringify({ query: 'query { gpuTypes { id displayName securePrice communityPrice } }' }),
  });
  return selectRunPodGpuRates(payload);
}

export async function fetchVastH100Rates({ fetch: fetchImpl = fetch } = {}) {
  const payload = await readJson(fetchImpl, VAST_BUNDLES_URL, { headers: { accept: 'application/json' } });
  return selectVastH100Rates(payload);
}
