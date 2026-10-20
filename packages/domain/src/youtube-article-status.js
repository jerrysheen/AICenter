import { addCalendarDays, zonedParts } from './zoned-time.js';

const FAIL_REASON = {
  failed: '模型没有整理完这一段',
  login: '整理页面需要重新登录',
  page: '整理页面没有打开',
};

const PAUSE_REASON = {
  quota: '模型额度暂时用完',
  upstream: '模型服务暂时出错',
  deadline: '这一轮已经停下',
};

// 心跳 30 秒。连续三次没有续上，就当成进程已经不在。
export const YOUTUBE_ARTICLE_LEASE_MS = 90_000;
// 一段模型调用最长约 5 分钟。开始前写下的时间要能盖住这一次调用。
export const YOUTUBE_ARTICLE_TOUCH_MS = 6 * 60_000;

export function youtubeArticleJobLive(jobs, now = Date.now()) {
  const at = Number(now);
  if (!Number.isFinite(at)) return false;
  return (Array.isArray(jobs) ? jobs : []).some((job) => {
    if (job?.status !== 'running') return false;
    const locked = Number(job?.lockedAt);
    return Number.isFinite(locked) && locked > 0 && at - locked <= YOUTUBE_ARTICLE_LEASE_MS;
  });
}

export function articleProgress(raw) {
  let state = null;
  try {
    const parsed = JSON.parse(raw || '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed;
  } catch {
    state = null;
  }
  const parts = Array.isArray(state?.parts) ? state.parts : [];
  const translated = parts.filter((part) => String(part?.translation || part?.reply || '').trim()).length;
  const organized = parts.filter((part) => String(part?.section || part?.reply || '').trim()).length;
  return {
    holdReason: String(state?.holdReason || ''),
    holdDay: String(state?.holdDay || ''),
    done: translated,
    translated,
    organized,
    total: parts.length,
    summary: String(state?.summary || '').trim(),
    titleStatus: String(state?.titleStatus || ''),
    touchedAt: Number(state?.touchedAt) || 0,
  };
}

function sameDay(left, right) {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

export function formatArticleWhen(atMs, nowMs, timeZone = 'Asia/Shanghai') {
  const at = Number(atMs);
  const now = Number(nowMs);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return '';
  const parts = zonedParts(at, timeZone);
  const today = zonedParts(now, timeZone);
  const clock = parts.minute === 0
    ? `${parts.hour}点`
    : `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  if (sameDay(parts, today)) return clock;
  const tomorrow = addCalendarDays(today.year, today.month, today.day, 1);
  if (parts.year === tomorrow.year && parts.month === tomorrow.month && parts.day === tomorrow.day) return `明天 ${clock}`;
  return `${parts.month}月${parts.day}日 ${clock}`;
}

function schedulePhrase(when, verb) {
  if (!when) return '';
  if (when.startsWith('明天') || when.includes('月')) return `，${verb}${when}`;
  return `，${verb} ${when}`;
}

function translatedLead(translated, organized, total) {
  if (!(total > 0)) return '';
  // 已经译出、还没写成小节的段数。28 段里 4 段整理完、24 段译好，就写「已译 24/28 段」。
  const waiting = organized > 0 && translated > organized ? translated - organized : translated;
  return `已译 ${waiting}/${total} 段`;
}

function pausedMessage({ translated, organized, total, hold, when }) {
  const lead = translatedLead(translated, organized, total);
  const reason = PAUSE_REASON[hold] || '等待下一轮';
  const clock = when ? `${when} 继续` : '';
  return [lead, reason, clock].filter(Boolean).join('，');
}

function finishingPhase({ organized, total, summary, titleStatus, articleStatus }) {
  if (articleStatus === 'ready') return false;
  if (!(total > 0) || organized < total) return false;
  if (!String(summary || '').trim()) return true;
  return String(titleStatus || '') !== 'ready';
}

export function describeYoutubeArticle({
  articleStatus = '',
  holdReason = '',
  done = 0,
  organized = 0,
  total = 0,
  summary = '',
  titleStatus = '',
  active = false,
  nextAt = null,
  overdue = false,
  now = Date.now(),
  timeZone = 'Asia/Shanghai',
} = {}) {
  const status = String(articleStatus || '');
  const hold = String(holdReason || '');
  const translated = Number(done) || 0;
  const sections = Number(organized) || 0;
  const count = Number(total) || 0;
  const when = formatArticleWhen(nextAt, now, timeZone);
  const base = { done: translated, organized: sections, total: count, holdReason: hold, nextAt: nextAt || null };
  if (status === 'ready') {
    return { status: 'ready', message: '', done: translated, organized: sections, total: count, holdReason: '', nextAt: nextAt || null };
  }
  if (hold === 'failed' || hold === 'login' || hold === 'page') {
    const reason = FAIL_REASON[hold] || '整理没有完成';
    const retry = when ? `${schedulePhrase(when, '将于')} 重试` : '';
    return {
      status: 'failed',
      message: `整理失败：${reason}${retry}`,
      ...base,
    };
  }
  const live = active === true;
  if (live && finishingPhase({ organized: sections, total: count, summary, titleStatus, articleStatus: status })) {
    return { status: 'running', message: '收尾中', ...base };
  }
  if (live && count > 0) {
    const cursor = translated >= count ? sections : translated;
    return { status: 'running', message: `整理中 ${cursor}/${count} 段`, ...base };
  }
  if (hold === 'daily-limit') {
    const retry = when ? `${schedulePhrase(when, '将于')} 处理` : '';
    return {
      status: 'queued',
      message: `今天的整理名额已用完${retry}`,
      ...base,
    };
  }
  if (hold === 'quota' || hold === 'upstream' || hold === 'deadline' || (count > 0 && (translated > 0 || sections > 0))) {
    return {
      status: 'queued',
      message: pausedMessage({ translated, organized: sections, total: count, hold, when }),
      ...base,
    };
  }
  if (status !== 'pending' && !hold) {
    return { status: '', message: '', ...base, holdReason: '', nextAt: null };
  }
  const dueAt = Number(nextAt);
  const missed = overdue === true || (Number.isFinite(dueAt) && dueAt > 0 && dueAt <= Number(now));
  if (missed) {
    const retry = when ? `${schedulePhrase(when, '将于')} 重试` : '';
    return {
      status: 'queued',
      message: `预计时间已过${retry}`,
      ...base,
    };
  }
  return {
    status: 'queued',
    message: `中文整理排队中${schedulePhrase(when, '预计')}${when ? ' 处理' : ''}`,
    ...base,
  };
}
