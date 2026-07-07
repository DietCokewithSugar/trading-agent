/**
 * 止盈腾位的纯选取逻辑:好候选因容量/现金受限被拒时,在当前盈利持仓中
 * 选一个"最接近止盈价"的全仓止盈,腾出容量/现金后重试候选。
 * 输入为 getValuation().positions 的形状(含 current_price / take_profit / unrealized_pnl)。
 */

/**
 * 选出待止盈腾位的持仓:未实现盈利 > 0 且设有止盈价的持仓中,
 * current_price / take_profit 比值最大者(离止盈最近);排除 excludeSymbol(禁止卖 X 再买 X)。
 * 无合格持仓返回 null。
 */
export function pickRotationSell(positions, { excludeSymbol = null } = {}) {
  let best = null;
  let bestRatio = -Infinity;
  for (const pos of positions || []) {
    if (!pos || (excludeSymbol && pos.symbol === excludeSymbol)) continue;
    const pnl = Number(pos.unrealized_pnl);
    const price = Number(pos.current_price);
    const takeProfit = Number(pos.take_profit);
    if (!(pnl > 0) || !(price > 0) || !(takeProfit > 0)) continue;
    const ratio = price / takeProfit;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = pos;
    }
  }
  return best;
}

/**
 * 无止盈线组合(trailing_only 系)的腾位选仓退化规则:没有止盈价可比时,
 * 选浮盈比例(unrealized_pnl_percent)最高的盈利持仓——"离止盈最近"在
 * 不设止盈的组合里的自然等价物。排除 excludeSymbol;无合格持仓返回 null。
 */
export function pickRotationSellByPnl(positions, { excludeSymbol = null } = {}) {
  let best = null;
  let bestPct = -Infinity;
  for (const pos of positions || []) {
    if (!pos || (excludeSymbol && pos.symbol === excludeSymbol)) continue;
    const pnl = Number(pos.unrealized_pnl);
    const pct = Number(pos.unrealized_pnl_percent);
    const price = Number(pos.current_price);
    if (!(pnl > 0) || !(price > 0) || !Number.isFinite(pct)) continue;
    if (pct > bestPct) {
      bestPct = pct;
      best = pos;
    }
  }
  return best;
}
