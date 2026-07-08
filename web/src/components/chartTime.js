// lightweight-charts 的时间工具(NetWorthChart / ComparisonChart 共用)。
// 图表库按 UTC 解读时间戳:整体平移到本地时区,坐标轴/刻度即显示本地钟点;
// 平移后的秒级时间戳用 UTC 读数取值 = 本地墙钟。

export const TZ_OFFSET_SEC = -new Date().getTimezoneOffset() * 60;

export const pad = (n) => String(n).padStart(2, '0');

/** 毫秒时间戳/ISO 字符串 → 平移后的秒级时间戳 */
export function toShiftedSec(msOrIso) {
  return Math.floor(new Date(msOrIso).getTime() / 1000) + TZ_OFFSET_SEC;
}

/** 平移后的秒级时间戳 → 本地钟点文本 */
export function fmtShiftedTime(sec, { withTime = true } = {}) {
  const d = new Date(sec * 1000);
  const date = `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
  if (!withTime) return date;
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 时间轴刻度:Year/Month/Day 档显示日期,更细档显示钟点 */
export function tickMarkFormatter(time, tickMarkType) {
  const d = new Date(time * 1000);
  if (tickMarkType <= 2) return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
