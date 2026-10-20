import { addCalendarDays, zonedParts } from './zoned-time.js';

const FAIL_REASON = {
  failed: '模型没有整理完这一段',
  quota: '模型额度暂时用完',
  login: '整理页面需要重新登录',
  page: '整理页面没有打开',
};

export function articleProgress(raw) {
  let state = null;
  try {
    const parsed = JSON.parse(raw || '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed;
  } catch {
    state = null;
  }
  const parts = Array.isArray(state?.parts) ? state.parts : [];
  const done = parts.filter((part) => String(part?.translation || part?.reply || '').trim()).length;
  return {
    holdReason: String(state?.holdReason || ''),
    holdDay: String(state?.holdDay || ''),
    done,
    total: parts.length,
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

export function describeYoutubeArticle({
  articleStatus = '',
  holdReason = '',
  done = 0,
  total = 0,
  nextAt = null,
  now = Date.now(),
  timeZone = 'Asia/Shanghai',
} = {}) {
  const status = String(articleStatus || '');
  const hold = String(holdReason || '');
  const finished = Number(done) || 0;
  const count = Number(total) || 0;
  const when = formatArticleWhen(nextAt, now, timeZone);
  if (status === 'ready') {
    return { status: 'ready', message: '', done: finished, total: count, holdReason: '', nextAt: nextAt || null };
  }
  if (hold === 'failed' || hold === 'quota' || hold === 'login' || hold === 'page') {
    const reason = FAIL_REASON[hold] || '整理没有完成';
    const retry = when ? `${schedulePhrase(when, '将于')} 重试` : '';
    return {
      status: 'failed',
      message: `整理失败：${reason}${retry}`,
      done: finished,
      total: count,
      holdReason: hold,
      nextAt: nextAt || null,
    };
  }
  if (hold !== 'daily-limit' && finished > 0 && count > 0) {
    return {
      status: 'running',
      message: `整理中 ${finished}/${count} 段`,
      done: finished,
      total: count,
      holdReason: hold,
      nextAt: nextAt || null,
    };
  }
  if (status !== 'pending' && !hold) {
    return { status: '', message: '', done: finished, total: count, holdReason: '', nextAt: null };
  }
  return {
    status: 'queued',
    message: `中文整理排队中${schedulePhrase(when, '预计')}${when ? ' 处理' : ''}`,
    done: finished,
    total: count,
    holdReason: hold,
    nextAt: nextAt || null,
  };
}
