import { INVESTOR_DISCUSSION_JOB_TYPE } from '../../contracts/src/investor-discussion.js';
import { addCalendarDays, formatYmd, zonedLocalToUtc, zonedParts } from './zoned-time.js';

export const INVESTOR_DISCUSSION_SYSTEM = [
  '你在整理雪球股民当天的公开讨论。',
  '只做总结，不写交易建议。',
  '传闻必须标「未证实」。',
  '不要预测涨跌，不要给出买卖、仓位或目标价。',
  '用 3 到 5 句中文概括：多空主要观点、情绪偏向、讨论热度、被反复提到的消息或传闻。',
  '只输出 JSON 对象，不要 Markdown。',
  '字段：summary 字符串；sentiment 只能是偏多、偏空、分歧、平淡之一；repeatedTopics 字符串数组；links 数组，每项含 title 和 url，url 必须来自材料里的原帖链接。',
].join('');

const SENTIMENTS = new Set(['偏多', '偏空', '分歧', '平淡']);
const COMMENT_COVERAGE_NOTE = '评论只含一级、不全';
const POST_PAGE_CAP_NOTE = '帖子可能未抓全（到达页数上限）';
const EMPTY_DISCUSSION_SUMMARY = '今天没人讨论';
const ADVICE = /[^。！？\n]*(?:建议买入|建议卖出|可以买入|应该卖出|加仓|减仓|止损|目标价)[^。！？\n]*[。！？]?/g;

export const DEFAULT_INVESTOR_THEMES = Object.freeze([
  {
    id: 'semiconductor',
    name: '半导体',
    keywords: ['半导体', '芯片', '晶圆'],
    symbols: ['SH688981', 'SZ002371', 'SH603501'],
  },
  {
    id: 'optical',
    name: '光通信',
    keywords: ['光模块', '光通信', 'CPO'],
    symbols: ['SZ300308', 'SZ300502'],
  },
  {
    id: 'memory',
    name: '存储',
    keywords: ['存储', 'DRAM', 'NAND', 'HBM'],
    symbols: ['SH603986', 'SH688008', 'SZ300223'],
  },
]);

function cloneTheme(theme) {
  return {
    id: String(theme.id || '').trim(),
    name: String(theme.name || '').trim(),
    keywords: [...new Set((theme.keywords || []).map((item) => String(item || '').trim()).filter(Boolean))],
    symbols: [...new Set((theme.symbols || []).map((item) => String(item || '').trim().toUpperCase()).filter((item) => /^(?:SH|SZ)\d{6}$|^\d{5}$/.test(item)))],
  };
}

export function resolveInvestorThemes(env = process.env) {
  const raw = String(env.AI_CENTER_INVESTOR_DIGEST_THEMES || '').trim();
  if (!raw) return DEFAULT_INVESTOR_THEMES.map(cloneTheme);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AI_CENTER_INVESTOR_DIGEST_THEMES 不是合法 JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('AI_CENTER_INVESTOR_DIGEST_THEMES 需要数组');
  return parsed.map((theme, index) => {
    const normalized = cloneTheme({ ...theme, id: theme?.id || `theme-${index + 1}` });
    if (!normalized.name || (!normalized.symbols.length && !normalized.keywords.length)) return null;
    return normalized;
  }).filter(Boolean);
}

export function discussionSymbolFromHolding(row) {
  const yahoo = String(row?.yahoo || '').trim().toUpperCase();
  const cn = yahoo.match(/^(\d{6})\.(SS|SZ)$/);
  if (cn) return `${cn[2] === 'SS' ? 'SH' : 'SZ'}${cn[1]}`;
  const hk = yahoo.match(/^(\d{1,5})\.HK$/);
  if (hk) return hk[1].padStart(5, '0');
  const code = String(row?.symbol || '').trim();
  const exchange = String(row?.exchangeCode || row?.exchange_code || '').toUpperCase();
  if (/^\d{6}$/.test(code) && (exchange === 'XSHG' || exchange === 'XSHE')) {
    return `${exchange === 'XSHG' ? 'SH' : 'SZ'}${code}`;
  }
  if (/^\d{1,5}$/.test(code) && exchange === 'XHKG') return code.padStart(5, '0');
  return '';
}

export function buildDiscussionTargets({ holdings = [], themes = [] } = {}) {
  const targets = [];
  const seen = new Set();
  const unmapped = [];
  for (const row of holdings) {
    const symbol = discussionSymbolFromHolding(row);
    const name = String(row?.name || row?.symbol || row?.yahoo || '持仓').trim() || '持仓';
    if (!symbol) {
      const key = `unmapped:${row?.symbol || row?.yahoo || name}`;
      if (!unmapped.some((item) => item.key === key)) unmapped.push({ key, name, reason: '无法换成雪球代码' });
      continue;
    }
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    targets.push({ kind: 'holding', key: symbol, name: name || symbol, symbols: [symbol], keywords: [] });
  }
  for (const theme of themes) {
    targets.push({
      kind: 'theme',
      key: `theme:${theme.id}`,
      name: theme.name,
      symbols: theme.symbols,
      keywords: theme.keywords,
    });
  }
  return { targets, unmapped };
}

export function discussionDayWindow(digestDate, timeZone) {
  const match = String(digestDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('日摘日期不正确');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const startAt = zonedLocalToUtc(year, month, day, 0, 0, timeZone);
  const next = addCalendarDays(year, month, day, 1);
  const endAt = zonedLocalToUtc(next.year, next.month, next.day, 0, 0, timeZone);
  return { startAt, endAt };
}

export function investorDigestDate(at, timeZone) {
  return formatYmd(zonedParts(at, timeZone));
}

export function stripTradingAdvice(value) {
  return String(value || '').replace(ADVICE, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function markUnverified(value) {
  return String(value || '').split(/(?<=[。！？\n])/).map((sentence) => {
    if (/传闻|据说|小道消息/.test(sentence) && !/未证实/.test(sentence)) {
      return sentence.replace(/\s*[。！？]?$/, '（未证实）。');
    }
    return sentence;
  }).join('');
}

function parseModelJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON');
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型没有返回 JSON 对象');
  return parsed;
}

export function pickDiscussionLinks(modelLinks, posts) {
  const allowed = new Map();
  for (const post of posts || []) {
    if (post?.url) allowed.set(post.url, post);
  }
  const picked = [];
  const push = (url, title) => {
    if (!url || picked.some((item) => item.url === url) || picked.length >= 3) return;
    picked.push({ title: String(title || '原帖').replace(/\s+/g, ' ').trim().slice(0, 80) || '原帖', url });
  };
  for (const link of modelLinks || []) {
    const url = String(link?.url || '').trim();
    if (!allowed.has(url)) continue;
    push(url, link?.title || allowed.get(url).title || allowed.get(url).text);
  }
  const ranked = [...(posts || [])].sort((left, right) => (right.replyCount || 0) - (left.replyCount || 0));
  for (const post of ranked) push(post.url, post.title || post.text);
  return picked;
}

export function readInvestorSummary(text, { posts, heat }) {
  const parsed = parseModelJson(text);
  let summary = markUnverified(stripTradingAdvice(parsed.summary));
  if (!summary) {
    summary = `当天讨论已收集。模型草稿含交易建议，已省略。热度 ${heat.posts} 帖、${heat.comments} 评论。`;
  }
  const sentiment = SENTIMENTS.has(parsed.sentiment) ? parsed.sentiment : '平淡';
  const repeatedTopics = (Array.isArray(parsed.repeatedTopics) ? parsed.repeatedTopics : [])
    .map((item) => markUnverified(stripTradingAdvice(item)))
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 6);
  return {
    summary,
    sentiment,
    repeatedTopics,
    links: pickDiscussionLinks(parsed.links, posts),
  };
}

function clip(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildInvestorDiscussionPrompt({ name, kind, posts, comments, heat, repair = false }) {
  const commentsByPost = new Map();
  for (const comment of comments || []) {
    const list = commentsByPost.get(comment.postId) || [];
    list.push(comment);
    commentsByPost.set(comment.postId, list);
  }
  const lines = [
    repair ? '上次输出无法解析。只返回 JSON 对象。' : '',
    `对象：${name}（${kind === 'theme' ? '主题' : '持仓'}）`,
    `讨论热度：帖子 ${heat.posts}，评论 ${heat.comments}。摘要里的热度必须使用这两个数字。`,
    '材料：',
  ].filter(Boolean);
  const shown = (posts || []).slice(0, 24);
  for (const post of shown) {
    lines.push(`帖子 ${post.author || '股民'} ${post.url}`);
    lines.push(clip(post.text || post.title, 280));
    for (const comment of (commentsByPost.get(post.id) || []).slice(0, 8)) {
      lines.push(`评论 ${comment.author || '股民'}：${clip(comment.text, 180)}`);
    }
  }
  if ((posts || []).length > shown.length) lines.push('其余帖子未写入材料。热度仍以上面的计数为准。');
  return lines.join('\n');
}

function emptySection(target, extra) {
  return {
    kind: target.kind,
    key: target.key,
    name: target.name,
    summary: '',
    sentiment: '',
    heat: { posts: 0, comments: 0 },
    repeatedTopics: [],
    links: [],
    fetchStatus: 'failed',
    reason: '',
    truncated: false,
    ...extra,
  };
}

function presentCoverage(sections, extra = {}) {
  const failed = sections.filter((item) => item.fetchStatus === 'failed' || item.fetchStatus === 'summary_failed');
  const succeeded = sections.length - failed.length;
  return {
    targets: sections.length,
    succeeded,
    failed: failed.length,
    postCount: sections.reduce((sum, item) => sum + (item.heat?.posts || 0), 0),
    commentCount: sections.reduce((sum, item) => sum + (item.heat?.comments || 0), 0),
    commentFetched: sections.reduce((sum, item) => sum + (item.heat?.comments || 0), 0),
    commentClaimed: sections.reduce((sum, item) => sum + (item.heat?.replyCount || 0), 0),
    commentNote: sections.some((item) => item.commentNote) ? COMMENT_COVERAGE_NOTE : '',
    postsTruncatedNote: sections.some((item) => item.truncated) ? POST_PAGE_CAP_NOTE : '',
    missing: failed.map((item) => ({ key: item.key, name: item.name, reason: item.reason || item.fetchStatus })),
    warnings: sections.filter((item) => item.fetchStatus === 'ok' && item.reason).map((item) => ({
      key: item.key, name: item.name, reason: item.reason,
    })),
    loginRequired: false,
    truncated: sections.some((item) => item.truncated),
    ...extra,
  };
}

function sectionRank(section) {
  if ((section.heat?.posts || 0) > 0) return 0;
  if (section.fetchStatus === 'empty') return 2;
  return 1;
}

function overallStatus(sections) {
  if (!sections.length) return 'ready';
  const bad = sections.filter((item) => item.fetchStatus === 'failed' || item.fetchStatus === 'summary_failed');
  const good = sections.length - bad.length;
  if (!good && bad.length) return 'failed';
  if (bad.length) return 'partial';
  return 'ready';
}

export function presentInvestorDigest(row, { pending = false } = {}) {
  if (!row) return null;
  let status = row.status;
  let error = row.error || '';
  if (status === 'running' && !pending) {
    status = 'failed';
    error = error || '生成中断，可以重新生成。';
  }
  return {
    date: row.digestDate,
    status,
    generatedAt: row.generatedAt ?? null,
    error,
    pending,
    coverage: row.coverage || {},
    sections: Array.isArray(row.sections) ? row.sections : [],
  };
}

function openForDate(listOpenJobs, digestDate) {
  const open = listOpenJobs?.(INVESTOR_DISCUSSION_JOB_TYPE) || [];
  return open.some((job) => {
    const jobDate = String(job?.input?.digestDate || '');
    return !digestDate || !jobDate || jobDate === digestDate;
  });
}

export function createInvestorDiscussionService({
  repository,
  listOpenJobs,
  now = () => Date.now(),
  timeZone = 'Asia/Shanghai',
}) {
  if (!repository?.get || !repository?.save) throw new Error('股民讨论日摘需要存储');
  return {
    latest(workspaceId = 'local', digestDate = investorDigestDate(now(), timeZone)) {
      const pending = openForDate(listOpenJobs, digestDate);
      return {
        digest: presentInvestorDigest(repository.get(workspaceId, digestDate), { pending }),
        pending,
        date: digestDate,
      };
    },
    async generate({
      workspaceId = 'local',
      digestDate,
      holdings,
      themes,
      client,
      summarize,
      model = '',
    }) {
      const date = digestDate || investorDigestDate(now(), timeZone);
      const window = discussionDayWindow(date, timeZone);
      const resolvedThemes = themes || resolveInvestorThemes(process.env);
      const built = buildDiscussionTargets({
        holdings: holdings || repository.listHoldings?.(workspaceId) || [],
        themes: resolvedThemes,
      });
      const previous = repository.get(workspaceId, date);
      repository.save({
        workspaceId,
        digestDate: date,
        status: 'running',
        generatedAt: previous?.generatedAt ?? null,
        model: previous?.model || model,
        coverage: previous?.coverage || {},
        sections: previous?.sections || [],
        error: '',
      });
      if (!client?.collectAll) throw new Error('雪球讨论采集未配置');
      let collected;
      try {
        collected = await client.collectAll(built.targets, window);
      } catch (error) {
        if (error?.code === 'login_required' || error?.code === 'verification_required') {
          const verification = error.code === 'verification_required';
          const message = String(error.message || (verification ? '雪球返回验证页。' : '采集浏览器尚未登录雪球。'));
          return repository.save({
            workspaceId,
            digestDate: date,
            status: verification ? 'verification_required' : 'login_required',
            generatedAt: now(),
            model,
            coverage: {
              ...presentCoverage([], {
                loginRequired: !verification,
                verificationRequired: verification,
                targets: built.targets.length,
                failed: built.targets.length,
              }),
              missing: built.targets.map((item) => ({ key: item.key, name: item.name, reason: message })),
            },
            sections: [],
            error: message,
          });
        }
        throw error;
      }
      const sections = built.unmapped.map((item) => emptySection({
        kind: 'holding', key: item.key, name: item.name,
      }, { reason: item.reason }));
      for (let index = 0; index < built.targets.length; index += 1) {
        const target = built.targets[index];
        const result = collected[index] || { failed: true, reason: '没有返回', posts: [], comments: [] };
        const heat = {
          posts: result.posts?.length || 0,
          comments: result.comments?.length || 0,
          replyCount: Number(result.commentClaimed) || 0,
        };
        const commentNote = result.commentsPartial ? COMMENT_COVERAGE_NOTE : '';
        if (result.failed || (!result.posts?.length && result.failures?.length)) {
          sections.push(emptySection(target, { reason: result.reason || '拉取失败', truncated: Boolean(result.truncated) }));
          continue;
        }
        if (!result.posts?.length) {
          sections.push({
            ...emptySection(target, { fetchStatus: 'empty', reason: result.reason || '' }),
            summary: EMPTY_DISCUSSION_SUMMARY,
            sentiment: '平淡',
            truncated: Boolean(result.truncated),
          });
          continue;
        }
        try {
          const draft = await summarize({
            system: INVESTOR_DISCUSSION_SYSTEM,
            prompt: buildInvestorDiscussionPrompt({ name: target.name, kind: target.kind, posts: result.posts, comments: result.comments, heat }),
          });
          let read;
          try {
            read = readInvestorSummary(draft.text, { posts: result.posts, heat });
          } catch {
            const repair = await summarize({
              system: INVESTOR_DISCUSSION_SYSTEM,
              prompt: buildInvestorDiscussionPrompt({
                name: target.name, kind: target.kind, posts: result.posts, comments: result.comments, heat, repair: true,
              }),
            });
            read = readInvestorSummary(repair.text, { posts: result.posts, heat });
          }
          sections.push({
            kind: target.kind,
            key: target.key,
            name: target.name,
            ...read,
            heat,
            fetchStatus: 'ok',
            reason: result.reason || '',
            commentNote,
            truncated: Boolean(result.truncated),
          });
        } catch (error) {
          sections.push(emptySection(target, {
            fetchStatus: 'summary_failed',
            reason: String(error?.message || error),
            heat,
            commentNote,
            truncated: Boolean(result.truncated),
          }));
        }
      }
      sections.sort((left, right) => sectionRank(left) - sectionRank(right));
      const status = overallStatus(sections);
      const error = status === 'failed'
        ? (sections.find((item) => item.reason)?.reason || '股民讨论日摘生成失败')
        : '';
      return repository.save({
        workspaceId,
        digestDate: date,
        status,
        generatedAt: now(),
        model,
        coverage: presentCoverage(sections),
        sections,
        error,
      });
    },
  };
}
