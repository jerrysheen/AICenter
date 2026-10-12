import { ComputePriceBoardSchema } from '../../contracts/src/compute-prices.js';
import { formatYmd, zonedParts } from './zoned-time.js';

export const COMPUTE_PRICE_TIME_ZONE = 'Asia/Shanghai';

function scaled(value, scale = 8) {
  const text = String(value || '');
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  const padded = (frac + '0'.repeat(scale)).slice(0, scale);
  return BigInt(whole) * (10n ** BigInt(scale)) + BigInt(padded);
}

export function changePercent(next, previous) {
  const current = scaled(next);
  const prior = scaled(previous);
  if (current == null || prior == null || prior === 0n) return null;
  const micro = ((current - prior) * 100_000_000n) / prior;
  const number = Number(micro) / 1_000_000;
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 10_000) / 10_000;
}

function latestPerDate(rows) {
  const byDate = new Map();
  for (const row of rows) byDate.set(row.quoteDate, row);
  return [...byDate.values()];
}

function priorRow(rows, quoteDate) {
  const dated = latestPerDate(rows).filter((row) => row.quoteDate < quoteDate);
  return dated.at(-1) || null;
}

export function quoteDateFor(capturedAt, timeZone = COMPUTE_PRICE_TIME_ZONE) {
  return formatYmd(zonedParts(capturedAt, timeZone));
}

export function createComputePriceService({ repository, timeZone = COMPUTE_PRICE_TIME_ZONE }) {
  return {
    save(workspaceId, input) {
      const explicit = typeof input?.quoteDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.quoteDate)
        ? input.quoteDate
        : '';
      const quoteDate = explicit || quoteDateFor(input.capturedAt, timeZone);
      return repository.save(workspaceId, input, quoteDate);
    },

    list(workspaceId) {
      const tokens = repository.latestTokens(workspaceId).map((row) => {
        const history = latestPerDate(repository.tokenHistory(workspaceId, row.modelKey));
        const previous = priorRow(history, row.quoteDate);
        return {
          modelKey: row.modelKey,
          modelId: row.modelId,
          name: row.name,
          quoteDate: row.quoteDate,
          promptPerMillion: row.promptPerMillion,
          completionPerMillion: row.completionPerMillion,
          contextLength: row.contextLength,
          promptChangePct: previous ? changePercent(row.promptPerMillion, previous.promptPerMillion) : null,
          completionChangePct: previous ? changePercent(row.completionPerMillion, previous.completionPerMillion) : null,
          history: history.slice(-180).map((point) => ({
            date: point.quoteDate,
            promptPerMillion: point.promptPerMillion,
            completionPerMillion: point.completionPerMillion,
          })),
          capturedAt: row.capturedAt,
        };
      });
      const gpus = repository.latestGpus(workspaceId).map((row) => {
        const history = latestPerDate(repository.gpuHistory(workspaceId, row.venue, row.gpuKey, row.lane));
        const previous = priorRow(history, row.quoteDate);
        return {
          venue: row.venue,
          gpuKey: row.gpuKey,
          label: row.label,
          lane: row.lane,
          quoteDate: row.quoteDate,
          usdPerHour: row.usdPerHour,
          sampleCount: row.sampleCount,
          changePct: previous ? changePercent(row.usdPerHour, previous.usdPerHour) : null,
          history: history.slice(-180).map((point) => ({ date: point.quoteDate, amount: point.usdPerHour })),
          capturedAt: row.capturedAt,
        };
      });
      return ComputePriceBoardSchema.parse({
        tokens,
        gpus,
        checks: repository.checks(workspaceId),
      });
    },
  };
}
