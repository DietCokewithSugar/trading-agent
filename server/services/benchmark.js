// 持仓期 SPY 基准:复盘/复查按超额收益(alpha)评判,而非绝对盈亏(beta)——
// 大盘涨 2% 的日子里平庸信号也像赢家,按原始盈亏沉淀的"教训"可能只是噪音。
// 纯函数 spyHoldingReturn 可单测;取数失败一律返回 null(fail-open,
// 基准缺失时 prompt 省略该字段,复盘/复查照常进行)。
import { getQuote, getHistoricalPricesAdjusted } from './fmp.js';

const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

/** 时间戳对应的美东日历日(YYYY-MM-DD);非法输入返回 null */
export function etDateOf(ts) {
  const d = ts instanceof Date ? ts : new Date(ts || NaN);
  if (Number.isNaN(d.getTime())) return null;
  return ET_DATE_FMT.format(d);
}

/** YYYY-MM-DD 往前推 N 天(给日线取数留出周末/假日余量) */
function shiftDateStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * 持仓期 SPY 收益(纯函数):rows 为升序日线 [{ date, price }];
 * 基准 = 建仓日(含)前最后一个收盘,终点 = 平仓日(含)前最后一个收盘。
 * 同一有效收盘日(日内持仓落到日线上无跨度)或数据缺失返回 null——
 * 日线对日内持仓是退化口径,同日持仓由调用方改用 SPY 当日涨跌近似。
 * 返回百分比(保留两位)。
 */
export function spyHoldingReturn({ rows, entryEtDate, exitEtDate } = {}) {
  if (!Array.isArray(rows) || !rows.length || !entryEtDate || !exitEtDate) return null;
  if (exitEtDate < entryEtDate) return null;
  let base = null;
  let end = null;
  for (const r of rows) {
    if (!r || !r.date || typeof r.price !== 'number' || !(r.price > 0)) continue;
    if (r.date <= entryEtDate) base = r;
    if (r.date <= exitEtDate) end = r;
  }
  if (!base || !end || base.date === end.date) return null;
  return Math.round((end.price / base.price - 1) * 10000) / 100;
}

/**
 * 一段持仓期的 SPY 基准收益:同一美东日内的持仓用 SPY 当日涨跌近似
 * (日线对日内是退化口径),跨日用股息调整日线收盘对收盘。
 * 返回 { spyReturnPercent, basis: 'intraday' | 'daily' } 或 null(fail-open)。
 */
export async function getHoldingBenchmark({ entryAt, exitAt } = {}) {
  try {
    const entryEtDate = etDateOf(entryAt);
    const exitEtDate = etDateOf(exitAt);
    if (!entryEtDate || !exitEtDate) return null;
    if (entryEtDate === exitEtDate) {
      const quote = await getQuote('SPY');
      const chg = Number(quote?.changesPercentage ?? quote?.changePercentage);
      if (!Number.isFinite(chg)) return null;
      return { spyReturnPercent: Math.round(chg * 100) / 100, basis: 'intraday' };
    }
    const { rows } = await getHistoricalPricesAdjusted(
      'SPY',
      shiftDateStr(entryEtDate, 7),
      exitEtDate
    );
    const ret = spyHoldingReturn({ rows, entryEtDate, exitEtDate });
    return ret === null ? null : { spyReturnPercent: ret, basis: 'daily' };
  } catch (err) {
    console.warn(`[memory] SPY 基准获取失败(复盘按绝对盈亏退化进行): ${err.message}`);
    return null;
  }
}
