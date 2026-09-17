import {
  parseContract, SourceManifestSchema, SourceSnapshotSchema, ValidationError,
} from '../../contracts/src/index.js';

function stableKey(value) {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function definitionFrom(registry, sourceId) {
  const definition = registry.getSourceDefinition?.(sourceId);
  if (!definition) throw new ValidationError(`未知 Source：${sourceId}`, ['sourceId']);
  return definition;
}

export function validateSourceDefinition(value) {
  if (!value || typeof value !== 'object') throw new ValidationError('Source 定义必须是对象', ['sources']);
  const manifest = parseContract(SourceManifestSchema, value.manifest);
  if (!value.inputSchema?.safeParse || !value.outputSchema?.safeParse) {
    throw new ValidationError(`Source ${manifest.id} 缺少运行时输入/输出 Schema`, ['sources']);
  }
  if (typeof value.read !== 'function') {
    throw new ValidationError(`Source ${manifest.id} 缺少 reader`, ['sources']);
  }
  if (value.projectForAI !== undefined && typeof value.projectForAI !== 'function') {
    throw new ValidationError(`Source ${manifest.id} 的 AI Projection 无效`, ['sources']);
  }
  return Object.freeze({ ...value, manifest: Object.freeze(manifest) });
}

export function createSourceHub(moduleRegistry, options = {}) {
  if (!moduleRegistry?.getSourceDefinition) throw new Error('SourceHub requires a module registry');
  const now = options.now || (() => Date.now());
  const cache = new Map();
  const pending = new Map();

  async function read(sourceId, input = {}, context = {}) {
    const definition = definitionFrom(moduleRegistry, sourceId);
    const parsedInput = parseContract(definition.inputSchema, input);
    const key = `${sourceId}:${stableKey(parsedInput)}`;
    const ttlMs = definition.manifest.refresh?.ttlMs || 0;
    const refresh = Boolean(context.refresh);
    const timestamp = now();
    if (!refresh && ttlMs > 0) {
      const hit = cache.get(key);
      if (hit && timestamp - hit.cachedAt < ttlMs) return hit.snapshot;
      if (pending.has(key)) return pending.get(key);
    }

    const task = Promise.resolve(definition.read(parsedInput, context)).then((output) => {
      const data = parseContract(definition.outputSchema, output);
      const observedAt = Number(definition.observedAt?.(data)) || now();
      const warnings = (definition.warnings?.(data) || []).filter(Boolean).map(String).slice(0, 32);
      const status = definition.status?.(data) || (warnings.length ? 'partial' : 'ready');
      const snapshot = parseContract(SourceSnapshotSchema, {
        sourceId,
        providerId: definition.manifest.providerId,
        observedAt,
        status,
        data,
        warnings,
      });
      if (ttlMs > 0) cache.set(key, { cachedAt: now(), snapshot });
      return snapshot;
    }).finally(() => pending.delete(key));
    if (!refresh && ttlMs > 0) pending.set(key, task);
    return task;
  }

  return Object.freeze({
    list(options = {}) {
      return moduleRegistry.listSources()
        .filter((manifest) => options.includeInternal || manifest.visibility === 'public');
    },
    describe(sourceId) {
      return definitionFrom(moduleRegistry, sourceId).manifest;
    },
    findByProvider(providerId, viewKind) {
      return moduleRegistry.listSources().find((manifest) => (
        manifest.providerId === providerId && (!viewKind || manifest.viewKind === viewKind)
      )) || null;
    },
    persistence(sourceId, input = {}) {
      const definition = definitionFrom(moduleRegistry, sourceId);
      return typeof definition.persistence === 'function'
        ? definition.persistence(parseContract(definition.inputSchema, input))
        : null;
    },
    read,
    async projectForAI(sourceId, input = {}, context = {}) {
      const definition = definitionFrom(moduleRegistry, sourceId);
      const snapshot = await read(sourceId, input, context);
      return Object.freeze({
        ...snapshot,
        data: definition.projectForAI ? definition.projectForAI(snapshot.data) : snapshot.data,
      });
    },
  });
}
