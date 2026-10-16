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
  const downsampleWindowMs = 2 * HOUR_MS;
  const downsample = database.prepare(`DELETE FROM polymarket_probability_points
    WHERE observed_at >= ? AND observed_at < ?
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
    WHERE observed_at >= ? AND observed_at < ? AND granularity != '1h'`);
  const dashboardPrior = database.prepare(`WITH ranked AS (
      SELECT event_id, market_id, outcome_key, observed_at, probability, granularity,
        ROW_NUMBER() OVER (
          PARTITION BY event_id, market_id, outcome_key
          ORDER BY ABS(observed_at - ?) ASC,
            CASE WHEN observed_at <= ? THEN 0 ELSE 1 END,
            observed_at ASC
        ) AS rn
      FROM polymarket_probability_points
      WHERE observed_at >= ? AND observed_at <= ?
    )
    SELECT event_id, market_id, outcome_key, observed_at, probability, granularity
    FROM ranked WHERE rn = 1`);
  const dashboardLatest = database.prepare(`WITH ranked AS (
      SELECT event_id, market_id, outcome_key, observed_at, probability, granularity,
        ROW_NUMBER() OVER (
          PARTITION BY event_id, market_id, outcome_key
          ORDER BY observed_at DESC
        ) AS rn
      FROM polymarket_probability_points
      WHERE observed_at >= ? AND observed_at <= ?
    )
    SELECT event_id, market_id, outcome_key, observed_at, probability, granularity
    FROM ranked WHERE rn = 1`);
  const dashboardEarliest = database.prepare(`WITH ranked AS (
      SELECT event_id, market_id, outcome_key, observed_at, probability, granularity,
        ROW_NUMBER() OVER (
          PARTITION BY event_id, market_id, outcome_key
          ORDER BY observed_at ASC
        ) AS rn
      FROM polymarket_probability_points
      WHERE observed_at <= ?
    )
    SELECT event_id, market_id, outcome_key, observed_at, probability, granularity
    FROM ranked WHERE rn = 1`);

  function runDownsample(cutoff) {
    const limit = Number(cutoff);
    if (!Number.isInteger(limit) || limit <= 0) return 0;
    const start = limit - downsampleWindowMs;
    const result = downsample.run(start, limit, limit);
    markHourly.run(start, limit);
    return result.changes;
  }
  const unwatchEvent = database.prepare(`UPDATE polymarket_outcomes
    SET watched = 0, lifecycle = 'closed', updated_at = ?
    WHERE event_id = ? AND watched = 1`);
  const insertCandidate = database.prepare(`INSERT OR IGNORE INTO polymarket_candidates (
      event_id, event_slug, title, tag_slug, volume_24h, total_volume, status, discovered_at, reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`);
  const listCandidatesByStatus = database.prepare(`SELECT * FROM polymarket_candidates
    WHERE status = ? ORDER BY discovered_at ASC, event_id ASC`);
  const listCandidateIds = database.prepare('SELECT event_id FROM polymarket_candidates');
  const reviewCandidateRow = database.prepare(`UPDATE polymarket_candidates
    SET status = ?, reviewed_at = ?
    WHERE event_id = ? AND status = 'pending'`);
  const insertAlert = database.prepare(`INSERT INTO polymarket_alerts (
      event_id, market_id, outcome_key, alert_type, message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`);
  const listAlerts = database.prepare(`SELECT id, event_id, market_id, outcome_key, alert_type, message, created_at
    FROM polymarket_alerts WHERE created_at >= ? ORDER BY created_at DESC, id DESC`);
  const deleteOldAlerts = database.prepare('DELETE FROM polymarket_alerts WHERE created_at < ?');
  const alertRetentionMs = 30 * 24 * 60 * 60 * 1000;
  const listStates = database.prepare(`SELECT event_id, market_id, outcome_key, state_key, state_value, updated_at
    FROM polymarket_alert_state`);
  const upsertState = database.prepare(`INSERT INTO polymarket_alert_state (
      event_id, market_id, outcome_key, state_key, state_value, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id, market_id, outcome_key, state_key) DO UPDATE SET
      state_value = excluded.state_value,
      updated_at = excluded.updated_at`);

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
        if (Number.isInteger(downsampleBefore) && downsampleBefore > 0) runDownsample(downsampleBefore);
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
      return runDownsample(cutoff);
    },

    listDashboardPoints(now, { dayMs = 24 * HOUR_MS, windowMs = 3 * HOUR_MS, latestMs = 2 * HOUR_MS } = {}) {
      const at = Math.trunc(Number(now));
      if (!Number.isInteger(at) || at < 0) return [];
      const target = at - dayMs;
      const priors = dashboardPrior.all(target, target, target - windowMs, target + windowMs).map(mapPoint);
      const latest = dashboardLatest.all(at - latestMs, at + 60_000).map(mapPoint);
      const earliest = dashboardEarliest.all(at - HOUR_MS).map(mapPoint);
      return [...priors, ...latest, ...earliest];
    },

    unwatchEvents(eventIds, at = Date.now()) {
      const updatedAt = Number.isInteger(at) ? at : Date.now();
      const ids = [...new Set((eventIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
      if (!ids.length) return 0;
      return database.transaction(() => {
        let changed = 0;
        for (const eventId of ids) changed += unwatchEvent.run(updatedAt, eventId).changes;
        return changed;
      })();
    },

    insertCandidates(candidates, at = Date.now()) {
      const discoveredAt = Number.isInteger(at) ? at : Date.now();
      const rows = (candidates || []).map((candidate) => {
        const eventId = String(candidate?.eventId || '').trim();
        const title = String(candidate?.title || '').trim();
        if (!eventId || eventId.length > 64) throw new ValidationError('候选事件标识不正确', ['eventId']);
        if (!title || title.length > 2_000) throw new ValidationError('候选标题不正确', ['title']);
        return {
          eventId,
          eventSlug: String(candidate?.eventSlug || '').slice(0, 256),
          title,
          tagSlug: String(candidate?.tagSlug || '').slice(0, 64),
          volume24h: decimalOrNull(candidate?.volume24h),
          totalVolume: decimalOrNull(candidate?.totalVolume),
        };
      });
      return database.transaction(() => {
        let inserted = 0;
        for (const row of rows) {
          inserted += insertCandidate.run(
            row.eventId, row.eventSlug, row.title, row.tagSlug, row.volume24h, row.totalVolume, discoveredAt,
          ).changes;
        }
        return inserted;
      })();
    },

    listCandidates(status = 'pending') {
      const name = String(status || 'pending');
      if (!['pending', 'approved', 'rejected'].includes(name)) return [];
      return listCandidatesByStatus.all(name).map((row) => ({
        eventId: row.event_id,
        eventSlug: row.event_slug,
        title: row.title,
        tagSlug: row.tag_slug,
        volume24h: row.volume_24h,
        totalVolume: row.total_volume,
        status: row.status,
        discoveredAt: row.discovered_at,
        reviewedAt: row.reviewed_at,
      }));
    },

    listCandidateEventIds() {
      return listCandidateIds.all().map((row) => row.event_id);
    },

    reviewCandidate(eventId, status, at = Date.now()) {
      const name = String(status || '');
      if (name !== 'approved' && name !== 'rejected') throw new ValidationError('审核状态不正确', ['status']);
      const id = String(eventId || '').trim();
      if (!id) throw new ValidationError('候选事件标识不正确', ['eventId']);
      const reviewedAt = Number.isInteger(at) ? at : Date.now();
      return reviewCandidateRow.run(name, reviewedAt, id).changes === 1;
    },

    listAlertsSince(from) {
      const start = Number(from);
      if (!Number.isInteger(start) || start < 0) return [];
      return listAlerts.all(start).map((row) => ({
        id: row.id,
        eventId: row.event_id,
        marketId: row.market_id,
        outcomeKey: row.outcome_key,
        alertType: row.alert_type,
        message: row.message,
        createdAt: row.created_at,
      }));
    },

    listAlertStates() {
      return listStates.all().map((row) => ({
        eventId: row.event_id,
        marketId: row.market_id,
        outcomeKey: row.outcome_key,
        stateKey: row.state_key,
        stateValue: row.state_value,
        updatedAt: row.updated_at,
      }));
    },

    recordAlerts({ alerts = [], states = [], now = Date.now() } = {}) {
      const samples = alerts.map((alert) => {
        const eventId = String(alert?.eventId || '').trim();
        const message = String(alert?.message || '').trim();
        const createdAt = Number(alert?.createdAt);
        if (!eventId || !message || !Number.isInteger(createdAt)) throw new ValidationError('告警不正确', ['alert']);
        return {
          eventId,
          marketId: String(alert?.marketId || ''),
          outcomeKey: String(alert?.outcomeKey || ''),
          alertType: String(alert?.alertType || '').slice(0, 40),
          message: message.slice(0, 120),
          createdAt,
        };
      });
      const next = states.map((state) => ({
        eventId: String(state?.eventId || '').trim(),
        marketId: String(state?.marketId || ''),
        outcomeKey: String(state?.outcomeKey || ''),
        stateKey: String(state?.stateKey || '').slice(0, 64),
        stateValue: String(state?.stateValue || '').slice(0, 200),
        updatedAt: Number(state?.updatedAt),
      })).filter((state) => state.eventId && state.stateKey && Number.isInteger(state.updatedAt));
      const recordedAt = Number.isInteger(Number(now)) ? Math.trunc(Number(now)) : Date.now();
      database.transaction(() => {
        for (const alert of samples) {
          insertAlert.run(alert.eventId, alert.marketId, alert.outcomeKey, alert.alertType, alert.message, alert.createdAt);
        }
        deleteOldAlerts.run(recordedAt - alertRetentionMs);
        for (const state of next) {
          upsertState.run(state.eventId, state.marketId, state.outcomeKey, state.stateKey, state.stateValue, state.updatedAt);
        }
      })();
      return { alerts: samples.length, states: next.length };
    },
  };
}
