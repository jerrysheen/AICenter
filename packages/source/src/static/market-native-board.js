import { z } from 'zod';
import { MarketNativeBoardSchema, parseContract } from '../../../contracts/src/index.js';

export const MarketNativeBoardInputSchema = z.object({
  predictionLimit: z.coerce.number().int().min(1).max(50).default(12),
}).strict();

function volume(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : -1;
}

export async function readMarketNativeBoard(sourcePort, rawInput = {}, options = {}) {
  if (!sourcePort?.list || !sourcePort?.read) throw new TypeError('market-native board requires a Source port');
  const input = parseContract(MarketNativeBoardInputSchema, rawInput);
  const now = options.now || (() => Date.now());
  const manifests = sourcePort.list().filter((source) => (
    ['prediction-market', 'crypto-derivatives', 'stablecoin-liquidity'].includes(source.viewKind)
  ));
  const settled = await Promise.all(manifests.map(async (manifest) => {
    try {
      const sourceInput = manifest.viewKind === 'prediction-market'
        ? { limit: input.predictionLimit }
        : {};
      const snapshot = await sourcePort.read(manifest.id, sourceInput, { refresh: Boolean(options.refresh) });
      return { manifest, snapshot, error: null };
    } catch (error) {
      return { manifest, snapshot: null, error };
    }
  }));

  const predictionMarkets = [];
  const cryptoDerivatives = [];
  let stablecoinLiquidity = null;
  const sourceHealth = settled.map(({ manifest, snapshot, error }) => {
    if (snapshot) {
      if (manifest.viewKind === 'prediction-market') predictionMarkets.push(...snapshot.data.quotes);
      if (manifest.viewKind === 'crypto-derivatives') cryptoDerivatives.push(...snapshot.data.quotes);
      if (manifest.viewKind === 'stablecoin-liquidity' && snapshot.data.available) stablecoinLiquidity = snapshot.data;
    }
    return {
      sourceId: manifest.id, title: manifest.title, viewKind: manifest.viewKind,
      status: snapshot?.status || 'unavailable', observedAt: snapshot?.observedAt ?? null,
      note: String(snapshot?.data?.note || snapshot?.warnings?.[0] || error?.message || '').slice(0, 1_000),
    };
  });

  return parseContract(MarketNativeBoardSchema, {
    generatedAt: now(),
    predictionMarkets: predictionMarkets
      .sort((left, right) => volume(right.volume24h) - volume(left.volume24h))
      .slice(0, input.predictionLimit * 2),
    cryptoDerivatives,
    stablecoinLiquidity,
    sourceHealth,
  });
}
