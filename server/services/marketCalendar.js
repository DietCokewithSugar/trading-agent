/**
 * NYSE/Nasdaq 交易日历:全天休市假日 + 13:00 提前收市的半日市。
 * 全部按规则计算(不依赖硬编码年份列表,不会过期),日期一律为美东 YYYY-MM-DD。
 */

/** 当月第 n 个星期 weekday(weekday: 0=周日…6=周六),返回日号 */
function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

/** 当月最后一个星期 weekday,返回日号 */
function lastWeekday(year, month, weekday) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return lastDay - ((last - weekday + 7) % 7);
}

/** 复活节(西方教会,Anonymous Gregorian 算法),返回 [month, day] */
function easter(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

function fmt(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function weekdayOf(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** 固定日期假日的观察日:落周六提前到周五,落周日顺延到周一 */
function observed(year, month, day) {
  const wd = weekdayOf(year, month, day);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (wd === 6) d.setUTCDate(d.getUTCDate() - 1);
  if (wd === 0) d.setUTCDate(d.getUTCDate() + 1);
  return fmt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** 按年缓存:{ holidays: Set<日期>, earlyCloses: Set<日期> } */
const yearCache = new Map();

function buildYear(year) {
  const holidays = new Set();

  // 元旦:1/1 落周六时 observed 返回上一年 12/31,但放进的是本年缓存,
  // 而查询 12/31 用的是上一年缓存——该键永远查不到。这恰好符合 NYSE 规则
  // (1/1 落周六不补休,如 2021-12-31 正常开市),是"碰巧正确":
  // 不要"修复"这个键错位,把 12/31 放进上一年缓存反而会错误地休市
  holidays.add(observed(year, 1, 1)); // 元旦
  holidays.add(fmt(year, 1, nthWeekday(year, 1, 1, 3))); // MLK 日:1 月第 3 个周一
  holidays.add(fmt(year, 2, nthWeekday(year, 2, 1, 3))); // 总统日:2 月第 3 个周一

  // 耶稣受难日:复活节前的周五
  const [em, ed] = easter(year);
  const gf = new Date(Date.UTC(year, em - 1, ed));
  gf.setUTCDate(gf.getUTCDate() - 2);
  holidays.add(fmt(year, gf.getUTCMonth() + 1, gf.getUTCDate()));

  holidays.add(fmt(year, 5, lastWeekday(year, 5, 1))); // 阵亡将士纪念日:5 月最后一个周一
  holidays.add(observed(year, 6, 19)); // 六月节
  holidays.add(observed(year, 7, 4)); // 独立日
  holidays.add(fmt(year, 9, nthWeekday(year, 9, 1, 1))); // 劳工节:9 月第 1 个周一
  const thanksgiving = nthWeekday(year, 11, 4, 4); // 感恩节:11 月第 4 个周四
  holidays.add(fmt(year, 11, thanksgiving));
  holidays.add(observed(year, 12, 25)); // 圣诞节

  // 13:00 提前收市:7/3、感恩节次日、12/24(须为工作日且自身不是休市日)
  const earlyCloses = new Set();
  const maybeEarly = (m, d) => {
    const wd = weekdayOf(year, m, d);
    const date = fmt(year, m, d);
    if (wd >= 1 && wd <= 5 && !holidays.has(date)) earlyCloses.add(date);
  };
  maybeEarly(7, 3);
  maybeEarly(11, thanksgiving + 1);
  maybeEarly(12, 24);

  return { holidays, earlyCloses };
}

function calendarFor(dateStr) {
  const year = Number(dateStr.slice(0, 4));
  if (!yearCache.has(year)) yearCache.set(year, buildYear(year));
  return yearCache.get(year);
}

/** 是否为交易所全天休市假日(dateStr: 美东 YYYY-MM-DD) */
export function isHoliday(dateStr) {
  return calendarFor(dateStr).holidays.has(dateStr);
}

/** 是否为 13:00 提前收市的半日市 */
export function isEarlyClose(dateStr) {
  return calendarFor(dateStr).earlyCloses.has(dateStr);
}

/** 是否为实际交易日(工作日且非假日),供夏普等日度指标过滤伪交易日 */
export function isTradingDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return false;
  const wd = weekdayOf(y, m, d);
  if (wd === 0 || wd === 6) return false;
  return !isHoliday(dateStr);
}

/**
 * 距常规时段开盘(美东 9:30,半日市开盘时间不变)的分钟数;
 * 非交易日或尚未开盘返回 null。开盘后前 ~15 分钟点差/波动显著放宽,
 * 滑点模型(execution.js)以此施加开盘窗口乘数——开盘触发的分配轮
 * 与开盘队列成交都落在这个窗口。
 */
export function minutesSinceMarketOpen(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return null;
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
  if (isHoliday(dateStr)) return null;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return minutes >= 570 ? minutes - 570 : null;
}
