import { CapabilityManifestSchema, parseContract, ValidationError } from '../../contracts/src/index.js';
import { validateSourceDefinition } from '../../source/src/source-hub.js';

export function createModuleRegistry() {
  const modules = new Map();
  const handlers = new Map();
  const sources = new Map();

  return Object.freeze({
    register(contribution) {
      const manifest = parseContract(CapabilityManifestSchema, contribution?.manifest);
      if (modules.has(manifest.id)) {
        throw new ValidationError(`模块 ${manifest.id} 已注册`, ['manifest.id']);
      }
      const jobHandlers = contribution?.jobHandlers || {};
      const sourceDefinitions = (contribution?.sources || []).map(validateSourceDefinition);
      for (const [jobType, handler] of Object.entries(jobHandlers)) {
        if (!manifest.jobTypes.includes(jobType)) {
          throw new ValidationError(`模块未声明任务类型 ${jobType}`, ['manifest.jobTypes']);
        }
        if (typeof handler !== 'function') {
          throw new ValidationError(`任务 ${jobType} 没有可执行 handler`, ['jobHandlers']);
        }
        if (handlers.has(jobType)) {
          throw new ValidationError(`任务类型 ${jobType} 已由其他模块提供`, ['jobHandlers']);
        }
      }
      for (const definition of sourceDefinitions) {
        const sourceId = definition.manifest.id;
        if (!manifest.sourceIds.includes(sourceId)) {
          throw new ValidationError(`模块未声明 Source ${sourceId}`, ['manifest.sourceIds']);
        }
        if (sources.has(sourceId)) {
          throw new ValidationError(`Source ${sourceId} 已由其他模块提供`, ['sources']);
        }
      }
      for (const sourceId of manifest.sourceIds) {
        if (!sourceDefinitions.some((item) => item.manifest.id === sourceId)) {
          throw new ValidationError(`模块声明的 Source ${sourceId} 没有定义`, ['sources']);
        }
      }
      const record = Object.freeze({
        manifest: Object.freeze(manifest),
        jobHandlers: Object.freeze({ ...jobHandlers }),
        sources: Object.freeze([...sourceDefinitions]),
      });
      modules.set(manifest.id, record);
      for (const [jobType, handler] of Object.entries(jobHandlers)) handlers.set(jobType, handler);
      for (const definition of sourceDefinitions) sources.set(definition.manifest.id, definition);
      return record.manifest;
    },

    listModules() {
      return [...modules.values()].map(({ manifest }) => manifest);
    },

    findByCapability(capability) {
      return [...modules.values()]
        .filter(({ manifest }) => manifest.capabilities.includes(capability))
        .map(({ manifest }) => manifest);
    },

    createJobHandlers() {
      return Object.freeze(Object.fromEntries(handlers));
    },

    listSources() {
      return [...sources.values()].map(({ manifest }) => manifest);
    },

    getSourceDefinition(sourceId) {
      return sources.get(sourceId) || null;
    },
  });
}

// Compatibility export for existing callers. The registry now owns module contributions,
// including both Job handlers and Sources.
export const createCapabilityRegistry = createModuleRegistry;
