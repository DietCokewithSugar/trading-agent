/**
 * 回测绩效指标(032,纯函数)。与论文口径对齐:CR% / ARR%(252 交易日年化)/
 * 夏普(√252 年化,rf=0)/ 最大回撤 %,另加交易次数与胜率(Wilson 95% CI)。
 * 夏普与回撤的数学与 statsService.js 的私有实现同口径(刻意拷贝而非重构 ——
 * statsService 在交易主链路上,观察层不去动它)。
 */

import { wilsonInterval } from '../signalStats.js';

const round2 = (n) => Math.round(n * 100) / 100;

/** 年化夏普(rf=0):日收益均值/样本标准差 × √252;有效收益样本 < 2 或波动为 0 → null */
export function computeSharpe(dailyValues) {
  if (!Array.isArray(dailyValues) || dailyValues.length < 3) return null;
  const returns = [];
  for (let i = 1; i < dailyValues.length; i++) {
    const prev = dailyValues[i - 1];
    if (prev > 0) returns.push(dailyValues[i] / prev - 1);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (!Number.isFinite(std) || std <= 0) return null;
  return round2((mean / std) * Math.sqrt(252));
}

/** 最大回撤(峰谷,百分比):净值序列为空或无正峰值 → 0 */
export function maxDrawdownPercent(dailyValues) {
  let peak = 0;
  let maxDrawdown = 0;
  for (const v of dailyValues || []) {
    if (!(v > 0)) continue;
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = ((peak - v) / peak) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }
  return round2(maxDrawdown);
}

/** 年化收益率(%):((final/initial)^(252/回报期数) − 1) × 100;回报期数 = 交易日数 − 1 */
export function annualizedReturnPercent(finalValue, initialValue, tradingDays) {
  if (!(finalValue > 0) || !(initialValue > 0) || !(tradingDays >= 2)) return null;
  const periods = Math.max(tradingDays - 1, 1);
  return round2(((finalValue / initialValue) ** (252 / periods) - 1) * 100);
}

/**
 * 汇总单标的单策略的全部指标。
 * equity = [{ date, value, pct }](每交易日一点),trades = engine 输出的成交列表。
 */
export function summarize({ equity = [], trades = [], initialValue }) {
  const values = equity.map((p) => p.value);
  const finalValue = values.length ? values[values.length - 1] : initialValue;
  const sells = trades.filter((t) => t.side === 'sell' && Number.isFinite(t.realized_pnl));
  const wins = sells.filter((t) => t.realized_pnl > 0).length;
  const winRate = sells.length ? round2((wins / sells.length) * 100) : null;
  return {
    cr_percent: initialValue > 0 ? round2(((finalValue - initialValue) / initialValue) * 100) : null,
    arr_percent: annualizedReturnPercent(finalValue, initialValue, values.length),
    sharpe: computeSharpe(values),
    max_drawdown_percent: maxDrawdownPercent(values),
    trade_count: trades.length,
    sell_count: sells.length,
    win_count: wins,
    win_rate: winRate,
    win_rate_ci: sells.length ? wilsonInterval(wins, sells.length) : null,
    final_value: round2(finalValue),
  };
}
