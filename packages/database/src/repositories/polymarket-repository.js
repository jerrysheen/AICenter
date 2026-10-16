import { ValidationError } from '../../../contracts/src/index.js';

const HOUR_MS = 3_600_000;

function decimalOrNull(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) throw new ValidationError('数值不正确', ['decimal']);
  return text;
}

function probabilityOrNull(value) {
  const text = decimalOrNull(value);
  if (text == null) return null;
  const number = Number(text);
  if (number < 0 || number > 1) throw new ValidationError('概率不正确', ['probability']);
  return text;
}

function outcomeRow(value) {
  const eventId = String(value?.eventId || '').trim();
  const marketId = String(value?.marketId || '').trim();
  const outcomeKey = String(value?.outcomeKey || '').trim();
  const title = String(value?.title || '').trim();
  const outcomeLabel = String(value?.outcomeLabel || '').trim();
  const sourceUrl = String(value?.sourceUrl || '').trim();
  const updatedAt = Number(value?.updatedAt);
  const lifecycle = String(value?.lifecycle || 'open');
  if (!eventId || eventId.length > 64) throw new ValidationError('事件标识不正确', ['eventId']);
  if (!marketId || marketId.length > 64) throw new ValidationError('市场标识不正确', ['marketId']);
  if (!outcomeKey || outcomeKey.length > 80) throw new ValidationError('结果标识不正确', ['outcomeKey']);
  if (!title || title.length > 2_000) throw new ValidationError('事件标题不正确', ['title']);
  if (!outcomeLabel || outcomeLabel.length > 256) throw new ValidationError('结果名称不正确', ['outcomeLabel']);
  if (!/^https:\/\//.test(sourceUrl)) throw new ValidationError('来源地址不正确', ['sourceUrl']);
  if (!['open', 'closed', 'pending_rollover'].includes(lifecycle)) throw new ValidationError('生命周期不正确', ['lifecycle']);
  if (!Number.isInteger(updatedAt) || updatedAt < 0) throw new ValidationError('更新时间不正确', ['updatedAt']);
  const endAt = value?.endAt == null ? null : Number(value.endAt);
  if (endAt != null && (!Number.isInteger(endAt) || endAt < 0)) throw new ValidationError('截止时间不正确', ['endAt']);
  return {
    eventId,
    marketId,
    outcomeKey,
    seriesId: String(value?.seriesId || '').slice(0, 64),
    watched: value?.watched ? 1 : 0,
    sortOrder: Number.isInteger(value?.sortOrder) ? value.sortOrder : 0,
    groupKey: String(value?.groupKey || '').slice(0, 64),
    alertProfile: ['binary', 'multi', 'geopolitics'].includes(value?.alertProfile) ? value.alertProfile : 'binary',
    eventSlug: String(value?.eventSlug || '').slice(0, 256),
    marketSlug: String(value?.marketSlug || '').slice(0, 256),
    title,
    outcomeLabel,
    lifecycle,
    endAt,
    liquidity: decimalOrNull(value?.liquidity),
    volume24h: decimalOrNull(value?.volume24h),
    totalVolume: decimalOrNull(value?.totalVolume),
    probability: probabilityOrNull(value?.probability),
    sourceUrl,
    updatedAt,
  };
}

function pointRow(value) {
  const eventId = String(value?.eventId || '').trim();
  const marketId = String(value?.marketId || '').trim();
  const outcomeKey = String(value?.outcomeKey || '').trim();
  const observedAt = Number(value?.observedAt);
  const probability = probabilityOrNull(value?.probability);
  const granularity = value?.granularity === '1m' || value?.granularity === '1h' ? value.granularity : '5m';
  if (!eventId || !marketId || !outcomeKey) throw new ValidationError('概率点标识不正确', ['point']);
  if (!Number.isInteger(observedAt) || observedAt < 0) throw new ValidationError('概率点时间不正确', ['observedAt']);
  if (!probability) throw new ValidationError('概率点缺少概率', ['probability']);
  return { eventId, marketId, outcomeKey, observedAt, probability, granularity };
}

function mapOutcome(row) {
  return {
    eventId: row.event_id,
    marketId: row.market_id,
    outcomeKey: row.outcome_key,
    seriesId: row.series_id,
    watched: Boolean(row.watched),
    sortOrder: row.sort_order,
    groupKey: row.group_key,
    alertProfile: row.alert_profile,
    eventSlug: row.event_slug,
    marketSlug: row.market_slug,
    title: row.title,
    outcomeLabel: row.outcome_label,
    lifecycle: row.lifecycle,
    endAt: row.end_at,
    liquidity: row.liquidity,
    volume24h: row.volume_24h,
    totalVolume: row.total_volume,
    probability: row.probability,
    sourceUrl: row.source_url,
    updatedAt: row.updated_at,
  };
}

function mapPoint(row) {
  return {
    eventId: row.event_id,
    marketId: row.market_id,
    outcomeKey: row.outcome_key,
    observedAt: row.observed_at,
    probability: row.probability,
    granularity: row.granularity,
  };
}

export function createPolymarketRepository(database, emitEvent = () => {}) {
  const upsert = database.prepare(`INSERT INTO polymarket_outcomes (
      event_id, market_id, outcome_key, series_id, watched, sort_order, group_key, alert_profile,
      event_slug, market_slug, title, outcome_label, lifecycle, end_at, liquidity, volume_24h,
      total_volume, probability, source_url, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id, market_id, outcome_key) DO UPDATE SET
      series_id = excluded.series_id,
      watched = excluded.watched,
      sort_order = excluded.sort_order,
      group_key = excluded.group_key,
      alert_profile = excluded.alert_profile,
      event_slug = excluded.event_slug,
      market_slug = excluded.market_slug,
      title = excluded.title,
      outcome_label = excluded.outcome_label,
      lifecycle = excluded.lifecycle,
      end_at = excluded.end_at,
      liquidity = excluded.liquidity,
      volume_24h = excluded.volume_24h,
      total_volume = excluded.total_volume,
      probability = excluded.probability,
      source_url = excluded.source_url,
      updated_at = excluded.updated_at`);
  const upsertPoint = database.prepare(`INSERT INTO polymarket_probability_points (
      event_id, market_id, outcome_key, observed_at, probability, granularity
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id, market_id, outcome_key, observed_at) DO UPDATE SET
      probability = excluded.probability,
      granularity = excluded.granularity`);
  const listWatched = database.prepare(`SELECT * FROM polymarket_outcomes
    WHERE watched = 1
    ORDER BY sort_order ASC, event_id ASC, market_id ASC`);
  const listSeries = database.prepare(`SELECT * FROM polymarket_outcomes
    WHERE series_id = ? AND watched = 1
    ORDER BY sort_order ASC, event_id ASC`);
  const listEvent = database.prepare(`SELECT market_id, outcome_key FROM polymarket_outcomes WHERE event_id = ?`);
  const closeMissing = database.prepare(`UPDATE polymarket_outcomes
    SET lifecycle = 'closed', updated_at = ?
    WHERE event_id = ? AND market_id = ? AND outcome_key = ? AND lifecycle != 'closed'`);
  const listPoints = database.prepare(`SELECT event_id, market_id, outcome_key, observed_at, probability, granularity
    FROM polymarket_probability_points
    WHERE observed_at >= ? AND observed_at <= ?
    ORDER BY observed_at ASC`);
  const downsample = database.prepare(`DELETE FROM polymarket_probability_points
    WHERE observed_at < ?
    AND EXISTS (
      SELECT 1 FROM polymarket_probability_points newer
      WHERE newer.event_id = polymarket_probability_points.event_id
        AND newer.market_id = polymarket_probability_points.market_id
        AND newer.outcome_key = polymarket_probability_points.outcome_key
        AND newer.observed_at < ?
        AND newer.observed_at / ${HOUR_MS} = polymarket_probability_points.observed_at / ${HOUR_MS}
        AND (
          newer.observed_at < polymarket_probability_points.observed_at
          OR (newer.observed_at = polymarket_probability_points.observed_at AND newer.rowid < polymarket_probability_points.rowid)
        )
    )`);
  const markHourly = database.prepare(`UPDATE polymarket_probability_points
    SET granularity = '1h'
    WHERE observed_at < ? AND granularity != '1h'`);

  return {
    saveWatchlist({ outcomes = [], points = [], syncedEventIds = [], downsampleBefore = null, at = Date.now() } = {}) {
      const rows = outcomes.map(outcomeRow);
      const samples = points.map(pointRow);
      const eventIds = [...new Set(syncedEventIds.map((id) => String(id || '').trim()).filter(Boolean))];
      const updatedAt = Number.isInteger(at) ? at : Date.now();
      database.transaction(() => {
        for (const row of rows) {
          upsert.run(
            row.eventId, row.marketId, row.outcomeKey, row.seriesId, row.watched, row.sortOrder, row.groupKey,
            row.alertProfile, row.eventSlug, row.marketSlug, row.title, row.outcomeLabel, row.lifecycle, row.endAt,
            row.liquidity, row.volume24h, row.totalVolume, row.probability, row.sourceUrl, row.updatedAt,
          );
        }
        const seen = new Map();
        for (const row of rows) {
          const keys = seen.get(row.eventId) || new Set();
          keys.add(`${row.marketId}\0${row.outcomeKey}`);
          seen.set(row.eventId, keys);
        }
        for (const eventId of eventIds) {
          const keys = seen.get(eventId) || new Set();
          for (const existing of listEvent.all(eventId)) {
            if (keys.has(`${existing.market_id}\0${existing.outcome_key}`)) continue;
            closeMissing.run(updatedAt, eventId, existing.market_id, existing.outcome_key);
          }
        }
        for (const point of samples) {
          upsertPoint.run(point.eventId, point.marketId, point.outcomeKey, point.observedAt, point.probability, point.granularity);
        }
        if (Number.isInteger(downsampleBefore) && downsampleBefore > 0) {
          downsample.run(downsampleBefore, downsampleBefore);
          markHourly.run(downsampleBefore);
        }
        emitEvent('market.polymarket.watchlist.saved.v1', 'polymarket-watchlist', String(updatedAt), {
          observedAt: updatedAt,
          outcomes: rows.length,
          points: samples.length,
        });
      })();
      return { outcomes: rows.length, points: samples.length };
    },

    listWatchedOutcomes() {
      return listWatched.all().map(mapOutcome);
    },

    listSeriesOutcomes(seriesId) {
      return listSeries.all(String(seriesId || '')).map(mapOutcome);
    },

    listPointsBetween(from, to) {
      const start = Number(from);
      const end = Number(to);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return [];
      return listPoints.all(start, end).map(mapPoint);
    },

    downsampleBefore(cutoff) {
      const limit = Number(cutoff);
      if (!Number.isInteger(limit) || limit <= 0) return 0;
      const result = downsample.run(limit, limit);
      markHourly.run(limit);
      return result.changes;
    },
  };
}
