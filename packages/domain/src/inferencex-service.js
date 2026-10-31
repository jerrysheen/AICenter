import {
  INFERENCE_BOARD_NOTE,
  InferenceAvailabilityRowSchema,
  InferenceBenchmarkRowSchema,
  InferenceBoardSchema,
  InferenceCheckSchema,
} from '../../contracts/src/inferencex.js';

function keep(schema, rows) {
  return (rows || []).flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

export function createInferencexService({ repository }) {
  if (!repository) throw new Error('inference repository is required');
  return {
    list(workspaceId = 'local') {
      const loaded = repository.latest(workspaceId);
      return InferenceBoardSchema.parse({
        note: INFERENCE_BOARD_NOTE,
        availability: keep(InferenceAvailabilityRowSchema, loaded.availability),
        benchmarks: keep(InferenceBenchmarkRowSchema, loaded.benchmarks),
        checks: keep(InferenceCheckSchema, loaded.checks),
      });
    },
    saveAvailability(workspaceId, input) {
      return repository.saveAvailability(workspaceId, input);
    },
    saveBenchmarks(workspaceId, input) {
      return repository.saveBenchmarks(workspaceId, input);
    },
    reject(workspaceId, sourceKey, input) {
      return repository.reject(workspaceId, sourceKey, input);
    },
  };
}
