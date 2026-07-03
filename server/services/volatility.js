// 波动自适应敞口(023):固定 ±2% 在不同波动的票上根本不是同一个 bracket——
// 高波动小票几小时被噪声随机扫损(bracket 在信号表达前先结算),低波动大票走满时限。
// 本模块按 20 日已实现日波动缩放 bracket:clamp(k × vol20, min%, max%),对称止损止盈。
// 上半部为纯函数(node:test 直接测),下半部 computeSymbolBracket 负责取数,
// 任何失败/数据不足都返回 null(fail-open:调用方回退固定百分比,绝不阻塞交易)。
import { config } from '../config.js';
import { getHistoricalPrices } from './fmp.js';

/** 相邻交易日简单收益率序列(%):rows 为日期升序的 [{date, price}](getHistoricalPrices 形状) */
export function dailyReturns(rows) {
  const prices = (rows || [])
    .map((r) => Number(r?.price))
    .filter((p) => Number.isFinite(p) && p > 0);
  const returns = [];
  for (let i = 1; i < prices.length; i += 1) {
    returns.push(((prices[i] - prices[i - 1]) / prices[i - 1]) * 100);
  }
  return returns;
}

/**
 * 20 日已实现日波动(%):最近 days 个日收益率的样本标准差。
 * 有效收益样本不足 minSamples(默认 10)时返回 null——半个月都不到的新股/数据洞,
 * 波动估计不可信,调用方回退固定 bracket。
 */
export function realizedVolPercent(rows, { days = 20, minSamples = 10 } = {}) {
  const returns = dailyReturns(rows).slice(-days);
  if (returns.length < minSamples) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Number(Math.sqrt(variance).toFixed(4));
}

/** bracket 宽度(%):clamp(k × vol, min, max);vol 为 null 时透传 null(回退固定值) */
export function computeBracket(volPercent, { k = 1, minPercent = 1.5, maxPercent = 4 } = {}) {
  const vol = Number(volPercent);
  if (!Number.isFinite(vol) || vol <= 0) return null;
  const raw = k * vol;
  return Number(Math.min(Math.max(raw, minPercent), maxPercent).toFixed(2));
}

/**
 * 取该股 20 日波动并算 bracket:约 35 个日历日的 EOD 历史(fmp 1h 缓存,
 * 每笔买入一次取数,成本可接受;EOD 数据无交易时段敏感性)。
 * 失败/不足 → { volPercent: null, bracketPercent: null },永不 throw。
 */
export async function computeSymbolBracket(symbol) {
  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 35 * 86400_000).toISOString().slice(0, 10);
    const rows = await getHistoricalPrices(symbol, from, to);
    const volPercent = realizedVolPercent(rows);
    if (volPercent === null) {
      console.log(`[vol] ${symbol} 20 日波动样本不足,回退固定 bracket`);
      return { volPercent: null, bracketPercent: null };
    }
    const bracketPercent = computeBracket(volPercent, {
      k: config.bracketVolK,
      minPercent: config.bracketMinPercent,
      maxPercent: config.bracketMaxPercent,
    });
    return { volPercent, bracketPercent };
  } catch (err) {
    console.warn(`[vol] ${symbol} 波动取数失败,回退固定 bracket: ${err.message}`);
    return { volPercent: null, bracketPercent: null };
  }
}
