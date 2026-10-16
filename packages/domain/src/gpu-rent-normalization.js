import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const defaultPath = fileURLToPath(new URL('../../../config/gpu-rent-normalization.json', import.meta.url));
const MODELS = new Set(['h100', 'h200', 'b200', 'b300', 'gb200']);
const TIERS = new Set(['guaranteed', 'community', 'median', 'index']);

let cached = null;

export function gpuRentNormalization(env = process.env) {
  const file = String(env.AI_CENTER_GPU_RENT_NORMALIZATION || '').trim() || defaultPath;
  if (cached?.file === file) return cached.value;
  const value = parseGpuRentNormalization(JSON.parse(readFileSync(file, 'utf8')));
  cached = { file, value };
  return value;
}

export function parseGpuRentNormalization(input) {
  const models = Array.isArray(input?.models) ? input.models : [];
  const tiers = Array.isArray(input?.tiers) ? input.tiers : [];
  const coverageModels = Array.isArray(input?.coverageModels) ? input.coverageModels : [];
  const ornn = Array.isArray(input?.ornn) ? input.ornn : [];
  if (!models.length || !tiers.length) throw new Error('GPU 租金归类配置缺少型号或档位');
  for (const item of models) {
    if (!MODELS.has(item?.model) || !/^[a-z0-9]+$/.test(item?.pattern || '')) {
      throw new Error('GPU 租金归类配置的型号无效');
    }
  }
  for (const item of tiers) {
    if (!item?.source || !TIERS.has(item?.tier) || (!item.lane && !item.laneSuffix)) {
      throw new Error('GPU 租金归类配置的档位无效');
    }
  }
  for (const model of coverageModels) {
    if (!MODELS.has(model)) throw new Error('GPU 租金归类配置的覆盖型号无效');
  }
  for (const item of ornn) {
    if (!item?.path || !/^[a-z0-9-]+$/.test(item?.variant || '') || !/^[a-z0-9-]+$/.test(item?.lane || '')) {
      throw new Error('GPU 租金归类配置的 Ornn 序列无效');
    }
  }
  return {
    models: models.map((item) => ({ model: item.model, pattern: String(item.pattern).toLowerCase() })),
    tiers: tiers.map((item) => ({
      source: String(item.source),
      lane: item.lane ? String(item.lane) : '',
      laneSuffix: item.laneSuffix ? String(item.laneSuffix) : '',
      tier: item.tier,
    })),
    coverageModels: [...coverageModels],
    ornn: ornn.map((item) => ({ path: String(item.path), variant: String(item.variant), lane: String(item.lane) })),
  };
}

export function normalizeGpuRentRow(mapping, row) {
  const model = matchModel(mapping, `${row?.variant || ''} ${row?.label || ''}`);
  const tier = matchTier(mapping, row?.sourceKey || row?.source, row?.lane);
  if (!model || !tier) return null;
  return { model, tier };
}

function matchModel(mapping, text) {
  const haystack = String(text || '').toLowerCase();
  for (const item of mapping.models) {
    if (haystack.includes(item.pattern)) return item.model;
  }
  return null;
}

function matchTier(mapping, source, lane) {
  const name = String(source || '');
  const value = String(lane || '');
  for (const item of mapping.tiers) {
    if (item.source !== name) continue;
    if (item.lane && item.lane === value) return item.tier;
    if (item.laneSuffix && value.endsWith(item.laneSuffix)) return item.tier;
  }
  return null;
}
