// Exchange closures, not the government's working-day / weekend makeup calendar.
// Source: https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml
const CLOSURES = [
  ['2026-01-01', '2026-01-03', '元旦'],
  ['2026-02-15', '2026-02-23', '春节'],
  ['2026-04-04', '2026-04-06', '清明节'],
  ['2026-05-01', '2026-05-05', '劳动节'],
  ['2026-06-19', '2026-06-21', '端午节'],
  ['2026-09-25', '2026-09-27', '中秋节'],
  ['2026-10-01', '2026-10-07', '国庆节'],
];
const DAY = 86400000, OFFSET = 8 * 3600000;

function dayInfo(day) {
  const date = new Date(day + OFFSET).toISOString().slice(0, 10);
  const weekday = new Date(day + OFFSET).getUTCDay();
  const holiday = CLOSURES.find(([start, end]) => date >= start && date <= end)?.[2];
  if (holiday) return { date, trading: false, reason: `${holiday}休市` };
  if (weekday === 0 || weekday === 6) return { date, trading: false, reason: '周末休市' };
  if (!date.startsWith('2026-')) return { date, trading: null, reason: '交易日历尚未核验' };
  return { date, trading: true, reason: '' };
}

export function cnTradingCalendarAt(at = Date.now()) {
  const day = Math.floor((at + OFFSET) / DAY) * DAY - OFFSET;
  const info = dayInfo(day), minute = Math.floor((at - day) / 60000);
  let session = 'closed', reason = info.reason;
  if (info.trading === null) session = 'unknown';
  if (info.trading) {
    if (minute < 555) { session = 'pre'; reason = '尚未开盘'; }
    else if (minute < 565) { session = 'pre'; reason = '开盘集合竞价'; }
    else if (minute < 570) { session = 'pre'; reason = '等待连续竞价'; }
    else if (minute < 690) { session = 'regular'; reason = '上午交易'; }
    else if (minute < 780) { session = 'break'; reason = '午间休市'; }
    else if (minute < 897) { session = 'regular'; reason = '下午交易'; }
    else if (minute < 900) { session = 'regular'; reason = '收盘集合竞价'; }
    else reason = '已收盘';
  }
  let nextOpenAt = null;
  for (let offset = 0; offset < 370; offset++) {
    const candidate = day + offset * DAY;
    const next = dayInfo(candidate);
    if (next.trading === null) break;
    if (!next.trading) continue;
    const morning = candidate + 570 * 60000, afternoon = candidate + 780 * 60000;
    if (at < morning) { nextOpenAt = morning; break; }
    if (at < afternoon) { nextOpenAt = afternoon; break; }
  }
  return { date: info.date, tradingDay: info.trading, session, reason, nextOpenAt,
    calendarYear: 2026, timezone: 'Asia/Shanghai' };
}

export function cnTradingCalendarNote(calendar) {
  const next = calendar.nextOpenAt == null ? '后续开市安排待核验' : `下次交易 ${new Date(calendar.nextOpenAt + OFFSET).toISOString().slice(0, 16).replace('T', ' ')}`;
  return `沪深 A/B 股：${calendar.reason}；${next}（北京时间）。休市期间涨跌为最近交易日变动。`;
}
