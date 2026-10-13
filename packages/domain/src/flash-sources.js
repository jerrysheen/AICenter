import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_FLASH_SOURCES = Object.freeze([
  { id: 'xueqiu:home:livenews', label: '雪球7x24' },
]);

function text(value) {
  return String(value || '').trim();
}

export function parseFlashSourceList(value) {
  return text(value).split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);
}

export function loadFlashSourceFile(configDirectory) {
  if (!configDirectory) return null;
  const file = path.join(configDirectory, 'flash-sources.json');
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sources = Array.isArray(parsed?.sources) ? parsed.sources : [];
  return sources.map((row) => ({
    id: text(row?.id),
    label: text(row?.label),
  })).filter((row) => row.id);
}

export function resolveFlashSources({ env = process.env, configured = null, mediaSources = [] } = {}) {
  const flagged = [];
  for (const source of mediaSources || []) {
    if (source?.flash !== true || !text(source.sourceKey)) continue;
    const label = text(source.publisher);
    flagged.push({ id: text(source.sourceKey), label });
    flagged.push({ id: `media:${text(source.sourceKey)}`, label });
  }
  const override = typeof env?.AI_CENTER_FLASH_SOURCES === 'string' ? env.AI_CENTER_FLASH_SOURCES : '';
  const rows = text(override)
    ? parseFlashSourceList(override).map((id) => ({ id, label: '' }))
    : [...(configured || DEFAULT_FLASH_SOURCES), ...flagged];
  const ids = new Set(rows.map((row) => row.id));
  const labels = new Set(rows.map((row) => row.label).filter(Boolean));
  return Object.freeze({ ids, labels });
}

export function loadResolvedFlashSources({ configDirectory, env = process.env, mediaSources = [] } = {}) {
  return resolveFlashSources({
    env,
    configured: loadFlashSourceFile(configDirectory),
    mediaSources,
  });
}

export function isFlashSource(ref, flash) {
  if (!flash?.ids) return false;
  if (typeof ref === 'string') return flash.ids.has(text(ref));
  if (!ref || typeof ref !== 'object') return false;
  const feed = ref.feed || ref.kind || ref.sourceInput?.feed || ref.metadata?.sourceInput?.feed;
  if ((feed === 'livenews' || feed === '7x24') && flash.ids.has('xueqiu:home:livenews')) return true;
  const keys = [
    ref.id, ref.externalId, ref.sourceExternalId, ref.sourceKey, ref.sourceId,
    ref.publisher, ref.sourceName, ref.displayName,
  ];
  if (ref.sourceKey) keys.push(`media:${text(ref.sourceKey)}`);
  return keys.some((key) => {
    const value = text(key);
    return value && (flash.ids.has(value) || flash.labels.has(value));
  });
}
