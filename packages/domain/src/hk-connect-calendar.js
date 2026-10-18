// 2026 南向关闭日来自港交所《沪港通及深港通交易日历》CSV。
// 2027 年港股通正式日历尚未公布。下面只列入港交所通告 CT/077/26（2026-06-01）
// 和港交所日历里、港股休市的工作日。半日仍开放，不在这张表里。
// 周末单独判断。没有整年日历的工作日 trading 为 null，实时任务按 pending / late 处理。
const CLOSED_2026 = {
  '2026-01-01': '两地休市',
  '2026-01-02': '沪深休市',
  '2026-02-16': '沪深休市',
  '2026-02-17': '两地休市',
  '2026-02-18': '两地休市',
  '2026-02-19': '两地休市',
  '2026-02-20': '沪深休市',
  '2026-02-23': '沪深休市',
  '2026-04-03': '港股休市',
  '2026-04-06': '两地休市',
  '2026-04-07': '港股休市',
  '2026-05-01': '两地休市',
  '2026-05-04': '沪深休市',
  '2026-05-05': '沪深休市',
  '2026-05-25': '港股休市',
  '2026-06-19': '两地休市',
  '2026-07-01': '港股休市',
  '2026-09-25': '沪深休市',
  '2026-10-01': '两地休市',
  '2026-10-02': '沪深休市',
  '2026-10-05': '沪深休市',
  '2026-10-06': '沪深休市',
  '2026-10-07': '沪深休市',
  '2026-10-19': '港股休市',
  '2026-12-25': '港股休市',
};

const HK_CLOSED_2027 = {
  '2027-01-01': '港股休市',
  '2027-02-08': '港股休市',
  '2027-02-09': '港股休市',
  '2027-03-26': '港股休市',
  '2027-03-29': '港股休市',
  '2027-04-05': '港股休市',
  '2027-05-13': '港股休市',
  '2027-06-09': '港股休市',
  '2027-07-01': '港股休市',
  '2027-09-16': '港股休市',
  '2027-10-01': '港股休市',
  '2027-10-08': '港股休市',
  '2027-12-27': '港股休市',
};

const CLOSED_BY_YEAR = {
  2026: CLOSED_2026,
};

function weekdayOf(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function addIsoDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * 86_400_000).toISOString().slice(0, 10);
}

export function eachIsoDate(from, to) {
  const dates = [];
  for (let cursor = from; cursor && to && cursor <= to; cursor = addIsoDays(cursor, 1)) dates.push(cursor);
  return dates;
}

export function classifyHkConnectDay(value) {
  const date = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { date, trading: null, reason: '日期无效' };
  const weekday = weekdayOf(date);
  if (weekday === 0 || weekday === 6) return { date, trading: false, reason: '周末' };
  const year = Number(date.slice(0, 4));
  const yearMap = CLOSED_BY_YEAR[year];
  if (yearMap) {
    const reason = yearMap[date];
    if (reason) return { date, trading: false, reason };
    return { date, trading: true, reason: '' };
  }
  const known = year === 2027 ? HK_CLOSED_2027[date] : '';
  if (known) return { date, trading: false, reason: known };
  return { date, trading: null, reason: '交易日历尚未核验' };
}

export function resolveBackfillStart(from, to, checkpoint) {
  if (!from || !to || from > to) return from || '';
  if (checkpoint && checkpoint >= from && checkpoint < to) return addIsoDays(checkpoint, 1);
  return from;
}
