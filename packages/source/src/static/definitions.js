import { z } from 'zod';
import {
  CalendarSourceViewSchema, OfficialReleaseSourceViewSchema, OfficialSourceDetailSchema,
} from '../../../contracts/src/index.js';

const CalendarInputSchema = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(1_000).default(200),
}).strict().refine((value) => value.from === undefined || value.to === undefined || value.from <= value.to, {
  message: 'from 不能晚于 to', path: ['from'],
});

const ReleaseInputSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

const OfficialDetailInputSchema = z.object({
  sourceUrl: z.url().refine((value) => value.startsWith('http://') || value.startsWith('https://'), '只支持 http 或 https 地址'),
}).strict();

const SOURCE_SPECS = Object.freeze([
  ['calendar.us.bls', '美国劳工统计发布日程', 'calendar', 'bls', 'calendar', 'bls', 21_600_000],
  ['calendar.us.bea', '美国经济分析发布日程', 'calendar', 'bea', 'calendar', 'bea', 21_600_000],
  ['calendar.us.census', '美国 Census 经济指标日程', 'calendar', 'census', 'calendar', 'census', 21_600_000],
  ['calendar.us.ism', '美国 ISM PMI 日程', 'calendar', 'ism', 'calendar', 'ism', 21_600_000],
  ['calendar.us.dol-claims', '美国初请失业金日程', 'calendar', 'dol', 'calendar', 'dolClaims', 21_600_000],
  ['calendar.cn.nbs', '中国国家统计局发布日程', 'calendar', 'nbs', 'calendar', 'nbs', 21_600_000],
  ['calendar.cn.customs', '中国海关统计发布日程', 'calendar', 'gacc', 'calendar', 'customs', 21_600_000],
  ['calendar.us.fed', '美联储完整日程', 'calendar', 'federal-reserve', 'calendar', 'fedCalendar', 3_600_000],
  ['calendar.us.fomc', 'FOMC 会议日程', 'calendar', 'federal-reserve', 'calendar', 'fomc', 21_600_000],
  ['calendar.cn.lpr', '中国 LPR 公布规则日程', 'calendar', 'pboc', 'calendar', 'lpr', 21_600_000],
  ['calendar.cn.scio', '国新办新闻发布会预告', 'calendar', 'scio', 'calendar', 'scio', 3_600_000],
  ['policy.us.federal-register', '美国 Federal Register', 'policy', 'federal-register', 'official-release', 'federalRegister', 900_000],
  ['policy.us.white-house', '美国白宫发布', 'policy', 'white-house', 'official-release', 'whiteHouse', 900_000],
  ['policy.us.fed', '美联储官方发布', 'policy', 'federal-reserve', 'official-release', 'fedReleases', 900_000],
  ['policy.cn.gov', '国务院政策文件库', 'policy', 'gov-cn', 'official-release', 'govCn', 900_000],
  ['policy.cn.gov-news', '中国政府重要会议发布', 'policy', 'gov-cn', 'official-release', 'govNews', 900_000],
  ['policy.cn.pboc', '中国人民银行发布', 'policy', 'pboc', 'official-release', 'pboc', 900_000],
]);

function unavailable(viewKind, sourceUrl, observedAt, error) {
  const message = String(error?.message || error || 'unavailable').replace(/\s+/g, ' ').slice(0, 300);
  return viewKind === 'calendar'
    ? { available: false, observedAt, sourceUrl, events: [], note: `官方来源暂不可读取：${message}` }
    : { available: false, observedAt, sourceUrl, releases: [], note: `官方来源暂不可读取：${message}` };
}

export function createStaticSignalSourceDefinitions(client, options = {}) {
  if (!client) throw new TypeError('static signal source definitions require an official sources client');
  const now = options.now || (() => Date.now());
  return SOURCE_SPECS.map(([id, title, category, providerId, viewKind, method, ttlMs]) => ({
    manifest: {
      id, title, category, providerId, visibility: 'public', viewKind,
      capabilities: ['read', 'refresh'], refresh: { ttlMs }, guideRefs: [],
    },
    inputSchema: viewKind === 'calendar' ? CalendarInputSchema : ReleaseInputSchema,
    outputSchema: viewKind === 'calendar' ? CalendarSourceViewSchema : OfficialReleaseSourceViewSchema,
    async read(input) {
      try { return await client[method](input); }
      catch (error) {
        const sourceUrl = client.urls?.[method] || client.urls?.[providerId] || 'https://example.invalid';
        return unavailable(viewKind, sourceUrl, now(), error);
      }
    },
    observedAt: (data) => data.observedAt,
    status: (data) => !data.available ? 'unavailable' : data.note ? 'partial' : 'ready',
    warnings: (data) => data.note ? [data.note] : [],
    projectForAI(data) {
      if (viewKind === 'calendar') {
        return { available: data.available, observedAt: data.observedAt, events: data.events, note: data.note };
      }
      return { available: data.available, observedAt: data.observedAt, releases: data.releases, note: data.note };
    },
  }));
}

export function createOfficialSourceDetailDefinition(client, options = {}) {
  if (!client) throw new TypeError('official source detail definition requires an official sources client');
  const now = options.now || (() => Date.now());
  return {
    manifest: {
      id: 'policy.official-detail', title: '官方信源详情读取', category: 'policy', providerId: 'official-sources',
      visibility: 'internal', viewKind: 'official-detail', capabilities: ['read', 'refresh'],
      refresh: { ttlMs: 900_000 }, guideRefs: [],
    },
    inputSchema: OfficialDetailInputSchema,
    outputSchema: OfficialSourceDetailSchema,
    async read(input) {
      try {
        if (typeof client.detail !== 'function') throw new Error('当前 Connector 未提供详情读取能力');
        return await client.detail(input);
      }
      catch (error) {
        return {
          available: false, sourceUrl: input.sourceUrl, title: '', officialSummary: '', bodyText: '',
          publishedAt: null, observedAt: now(), truncated: false,
          note: `官方详情暂不可读取：${String(error?.message || error || 'unavailable').replace(/\s+/g, ' ').slice(0, 300)}`,
        };
      }
    },
    observedAt: (data) => data.observedAt,
    status: (data) => !data.available ? 'unavailable' : data.note ? 'partial' : 'ready',
    warnings: (data) => data.note ? [data.note] : [],
    projectForAI(data) { return data; },
  };
}

export { CalendarInputSchema, ReleaseInputSchema, OfficialDetailInputSchema };
