import { DIVIDEND_STRATEGY_KEY, parseContract, StrategySnapshotSchema } from '../../../contracts/src/index.js';
import { zonedLocalToUtc, zonedParts } from '../zoned-time.js';
import { classifyDividendRegime } from './dividend-value.js';

export const DIVIDEND_INDEX = '000922';
export const DIVIDEND_STRATEGY_TIMEZONE = 'Asia/Shanghai';
export const DIVIDEND_STRATEGY_HOUR = 15;
export const DIVIDEND_STRATEGY_MINUTE = 30;

function shanghaiDayStart(at) {
  const parts = zonedParts(at, DIVIDEND_STRATEGY_TIMEZONE);
  return zonedLocalToUtc(parts.year, parts.month, parts.day, 0, 0, DIVIDEND_STRATEGY_TIMEZONE);
}

function factorsFromBasket(basket) {
  const factors = {
    value: basket.value,
    pain: basket.pain,
    dataQuality: basket.dataQuality,
    regime: 'UNKNOWN',
  };
  factors.regime = classifyDividendRegime(factors);
  return factors;
}

export function createDividendStrategyService({
  strategyRepository,
  basketPort,
  now = () => Date.now(),
}) {
  if (!strategyRepository?.upsertStrategySnapshot) throw new Error('dividend strategy requires a snapshot repository');

  return Object.freeze({
    getLatest(workspaceId = 'local') {
      return strategyRepository.getLatestStrategySnapshot(workspaceId, DIVIDEND_STRATEGY_KEY);
    },
    latestBefore(workspaceId, beforeAt) {
      return strategyRepository.getLatestStrategySnapshotBefore(workspaceId, DIVIDEND_STRATEGY_KEY, beforeAt);
    },
    async captureDividendSnapshot(input = {}) {
      const workspaceId = input.workspaceId || 'local';
      const clock = Number.isInteger(input.scheduledFor) ? input.scheduledFor : now();
      let basket = null;
      const warnings = [];
      if (!basketPort?.getBasketStatistics) {
        warnings.push('篮子统计不可用');
      } else {
        try {
          basket = await basketPort.getBasketStatistics({
            index: DIVIDEND_INDEX,
            range: '5y',
            asOf: clock,
          });
          if (Array.isArray(basket?.warnings)) warnings.push(...basket.warnings);
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : '篮子统计失败');
        }
      }
      const factors = basket
        ? factorsFromBasket(basket)
        : factorsFromBasket({
          value: {
            dividendYield: null, dividendYieldPercentile5y: null, peTtm: null, pePercentile5y: null, pb: null, pbPercentile5y: null,
          },
          pain: {
            return20d: null, return60d: null, return120d: null, return252d: null, drawdown252d: null,
            distanceToMA20: null, distanceToMA60: null, distanceToMA120: null, distanceToMA250: null,
            breadthAboveMA20: null, breadthAboveMA60: null,
          },
          dataQuality: {
            constituentCount: 0, coverage: 0, earningsCoverage: 0, negativePeWeight: 0, missingWeight: 1, adjustedPrice: false,
          },
        });
      const asOf = Number.isInteger(basket?.asOf) ? basket.asOf : shanghaiDayStart(clock);
      const status = basket?.status || 'unavailable';
      return strategyRepository.upsertStrategySnapshot({
        workspaceId,
        strategyKey: DIVIDEND_STRATEGY_KEY,
        asOf,
        status,
        factors: parseContract(StrategySnapshotSchema.shape.factors, factors),
        warnings: [...new Set(warnings.map((warning) => String(warning).trim()).filter(Boolean))].slice(0, 30),
      });
    },
  });
}
