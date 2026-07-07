// 影子组合记账的纯计算部分(017,node:test 直接测):
// 买入金额硬帽 / 加权平均成本 / 卖出盈亏 / 镜像仓位还原 / 宏观拦截候选选取。
// 数据库与编排在 shadowPortfolio.js。
import { config } from '../config.js';

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * 影子组合单笔买入金额:与实盘同口径的基础硬帽——
 * spend = min(fraction×组合总值, maxBuyCashFraction×组合总值, 现金),
 * 且买后该票市值 ≤ maxPositionFraction×组合总值;低于 minOrderAmount 返回 0(跳过)。
 * benchmark=true(SPY 基准建仓)只受现金约束。
 * 注意:影子组合刻意不实现宏观三重钳制/行业帽/持仓数上限——那些正是部分变体要消融的层。
 */
export function computeShadowSpend({
  fraction,
  cash,
  totalValue,
  positionValue = 0,
  benchmark = false,
  caps = {},
} = {}) {
  const {
    maxBuyCashFraction = config.maxBuyCashFraction,
    maxPositionFraction = config.maxPositionFraction,
    minOrderAmount = config.minOrderAmount,
  } = caps;
  if (!(Number(cash) > 0) || !(Number(totalValue) > 0) || !(Number(fraction) > 0)) return 0;
  let spend = benchmark
    ? Number(cash)
    : Math.min(fraction * totalValue, maxBuyCashFraction * totalValue, Number(cash));
  if (!benchmark) {
    const headroom = maxPositionFraction * totalValue - Number(positionValue);
    spend = Math.min(spend, Math.max(headroom, 0));
  }
  spend = Math.min(spend, Number(cash));
  return spend >= minOrderAmount ? round2(spend) : 0;
}

/**
 * 买入后的持仓状态(加权平均成本;止损/止盈按新的平均成本重设,与实盘 execute_trade 同口径)。
 * position 为 null 表示开新仓;不传止损/止盈时保留原值(镜像成交可能不带)。
 */
export function applyBuy(position, { quantity, amount, stopLossPercent = null, takeProfitPercent = null }) {
  const oldQty = position ? Number(position.quantity) : 0;
  const oldCost = position ? Number(position.avg_cost) : 0;
  const newQty = round4(oldQty + Number(quantity));
  const newAvg = round4((oldQty * oldCost + Number(amount)) / newQty);
  return {
    quantity: newQty,
    avg_cost: newAvg,
    stop_loss:
      stopLossPercent !== null && stopLossPercent !== undefined
        ? round4(newAvg * (1 - stopLossPercent / 100))
        : (position?.stop_loss ?? null),
    take_profit:
      takeProfitPercent !== null && takeProfitPercent !== undefined
        ? round4(newAvg * (1 + takeProfitPercent / 100))
        : (position?.take_profit ?? null),
  };
}

/**
 * 卖出结算(与实盘 executeSellOrder 同口径):余量过小或 fraction ≥ 0.99 时清仓。
 * 返回 { quantity, remaining, amount, realizedPnl };remaining=0 表示持仓应删除。
 */
export function applySell(position, fraction, fillPrice) {
  const held = Number(position.quantity);
  let quantity = round4(held * Math.min(Math.max(Number(fraction) || 0, 0), 1));
  if (held - quantity < 0.0001 || fraction >= 0.99) quantity = held;
  const remaining = round4(held - quantity);
  return {
    quantity,
    remaining: remaining <= 0.0001 ? 0 : remaining,
    amount: round2(quantity * fillPrice),
    realizedPnl: round2((fillPrice - Number(position.avg_cost)) * quantity),
  };
}

/**
 * 镜像买入的仓位还原:去掉被消融层施加的缩放(scale ∈ (0,1) 才还原;
 * 1=未缩放,非法/0 不除——宁可少买也不放大出 Infinity)。
 */
export function unscaleFraction(fraction, scale) {
  const f = Number(fraction);
  const s = Number(scale);
  if (!Number.isFinite(f) || f <= 0) return 0;
  if (!Number.isFinite(s) || s <= 0 || s >= 1) return round4(f);
  return round4(f / s);
}

/**
 * 双向仓位还原:去掉被消融层施加的任意正缩放(宏观乘数 risk_off ×0.5 要放大还原,
 * risk_on ×1.2 也要缩小还原——无宏观层的变体两个方向的缩放都不该有)。
 * 非法/0 缩放不除,按原值返回(宁可跟单也不放大出 Infinity)。
 */
export function unapplyScale(fraction, scale) {
  const f = Number(fraction);
  const s = Number(scale);
  if (!Number.isFinite(f) || f <= 0) return 0;
  if (!Number.isFinite(s) || s <= 0 || s === 1) return round4(f);
  return round4(f / s);
}

/**
 * 宏观拦截候选中选出影子组合本轮可重放的前 N 个:按当前分降序,
 * 跳过没有 analysis_id 或该变体已买过的(去重键 variant+analysis_id)。
 */
export function pickTopBlocked(candidates, { max = 3, excludeAnalysisIds = new Set() } = {}) {
  return [...(candidates || [])]
    .filter((c) => c?.symbol && c.analysis_id && !excludeAnalysisIds.has(c.analysis_id))
    .sort((a, b) => (Number(b.current_score) || 0) - (Number(a.current_score) || 0))
    .slice(0, Math.max(max, 0));
}

/**
 * 影子持仓 → 止盈腾位选仓输入(纯函数,024):补齐 pickRotationSell 需要的
 * unrealized_pnl/current_price 字段;无实时报价的持仓丢弃(不据不可信估值腾位)。
 */
export function toRotationPositions(positions, priceBySymbol) {
  const out = [];
  for (const p of positions || []) {
    const price = Number(priceBySymbol?.get?.(p.symbol));
    if (!(price > 0)) continue;
    out.push({
      symbol: p.symbol,
      current_price: price,
      take_profit: p.take_profit,
      avg_cost: Number(p.avg_cost),
      unrealized_pnl: round2((price - Number(p.avg_cost)) * Number(p.quantity)),
    });
  }
  return out;
}

/** 用报价(缺失时退回平均成本)为影子持仓估值,返回 { positionsValue, totalValue } */
export function valuePositions(positions, priceBySymbol, cash) {
  let positionsValue = 0;
  for (const p of positions || []) {
    const price = Number(priceBySymbol?.get?.(p.symbol)) || Number(p.avg_cost);
    positionsValue += price * Number(p.quantity);
  }
  return {
    positionsValue: round2(positionsValue),
    totalValue: round2(positionsValue + Number(cash)),
  };
}

/**
 * 休市顺延信号队列的修剪(纯函数):去掉超龄条目(与实盘开盘队列同一时效语义),
 * 超过容量上限时丢弃最老的。entries 须带 queuedAt(毫秒时间戳),保持原有顺序。
 * 返回 { kept, expired, dropped }。
 */
export function prunePendingSignals(entries, { now = Date.now(), maxAgeMs, maxSize } = {}) {
  const list = entries || [];
  const fresh = list.filter((e) => Number.isFinite(e?.queuedAt) && now - e.queuedAt <= maxAgeMs);
  const dropped = maxSize > 0 && fresh.length > maxSize ? fresh.length - maxSize : 0;
  return {
    kept: dropped ? fresh.slice(dropped) : fresh,
    expired: list.length - fresh.length,
    dropped,
  };
}
