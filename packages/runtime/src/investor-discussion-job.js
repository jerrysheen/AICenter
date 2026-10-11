import { InvestorDiscussionGenerateInputSchema, INVESTOR_DISCUSSION_JOB_TYPE, parseContract } from '../../contracts/src/index.js';
import { createGeminiInvestorSummarizer, investorDiscussionModelId } from '../../connectors/src/investor-discussion-model.js';
import { createXueqiuStockDiscussionClient } from '../../connectors/src/xueqiu/stock-discussion.js';
import { createInvestorDiscussionService, investorDigestDate, resolveInvestorThemes } from '../../domain/src/investor-discussion.js';
import { dailySlotOnInstant } from '../../domain/src/zoned-time.js';

export { INVESTOR_DISCUSSION_JOB_TYPE };
export const INVESTOR_DISCUSSION_SCHEDULE_KEY = 'investor.discussion.daily';

export const investorDiscussionManifest = Object.freeze({
  id: 'investor.discussion',
  version: '1.0.0',
  capabilities: ['investor.discussion.digest'],
  jobTypes: [INVESTOR_DISCUSSION_JOB_TYPE],
});

export function parseInvestorDigestClock(value = '21:30') {
  const match = String(value || '21:30').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error('AI_CENTER_INVESTOR_DIGEST_AT 需要 HH:MM');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('AI_CENTER_INVESTOR_DIGEST_AT 需要 HH:MM');
  return { hour, minute };
}

function envInt(env, key, fallback, min, max) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function investorDigestRuntimeConfig(env = process.env) {
  const clock = parseInvestorDigestClock(env.AI_CENTER_INVESTOR_DIGEST_AT || '21:30');
  const timeZone = String(env.AI_CENTER_INVESTOR_DIGEST_TIMEZONE || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
  return {
    enabled: String(env.AI_CENTER_INVESTOR_DIGEST ?? '1') !== '0',
    timeZone,
    hour: clock.hour,
    minute: clock.minute,
    intervalMs: envInt(env, 'AI_CENTER_INVESTOR_DIGEST_INTERVAL_MS', 1200, 0, 60_000),
    retries: envInt(env, 'AI_CENTER_INVESTOR_DIGEST_RETRIES', 2, 0, 5),
    maxPages: envInt(env, 'AI_CENTER_INVESTOR_DIGEST_MAX_PAGES', 8, 1, 20),
    maxCommentPages: envInt(env, 'AI_CENTER_INVESTOR_DIGEST_MAX_COMMENT_PAGES', 5, 1, 10),
    model: investorDiscussionModelId(env),
  };
}

export function ensureInvestorDiscussionSchedule(store, env = process.env, now = Date.now()) {
  const config = investorDigestRuntimeConfig(env);
  const nextRunAt = config.enabled
    ? dailySlotOnInstant(now, { timeZone: config.timeZone, hour: config.hour, minute: config.minute })
    : now;
  return store.upsertJobSchedule({
    workspaceId: 'local',
    key: INVESTOR_DISCUSSION_SCHEDULE_KEY,
    jobType: INVESTOR_DISCUSSION_JOB_TYPE,
    enabled: config.enabled,
    schedule: { kind: 'daily', timezone: config.timeZone, hour: config.hour, minute: config.minute },
    input: {},
    priority: 0,
    maxAttempts: 2,
    nextRunAt,
  });
}

export function createInvestorDiscussionJobHandlers({
  repository,
  browserRuntime,
  env = process.env,
  client,
  summarize,
  now = () => Date.now(),
} = {}) {
  if (!repository) throw new Error('股民讨论日摘需要存储');
  const config = investorDigestRuntimeConfig(env);
  const service = createInvestorDiscussionService({ repository, now, timeZone: config.timeZone });
  const discussion = client || createXueqiuStockDiscussionClient({
    browserRuntime,
    intervalMs: config.intervalMs,
    retries: config.retries,
    maxPages: config.maxPages,
    maxCommentPages: config.maxCommentPages,
  });
  const model = summarize || createGeminiInvestorSummarizer({ env, model: config.model });
  return {
    [INVESTOR_DISCUSSION_JOB_TYPE]: async (rawInput) => {
      const input = parseContract(InvestorDiscussionGenerateInputSchema, rawInput || {});
      const digestDate = input.digestDate || investorDigestDate(input.scheduledFor || now(), config.timeZone);
      const themes = resolveInvestorThemes(env);
      const saved = await service.generate({
        workspaceId: input.workspaceId || 'local',
        digestDate,
        themes,
        client: discussion,
        summarize: model,
        model: config.model,
      });
      return { digestDate: saved.digestDate, status: saved.status };
    },
  };
}
