// 订单冲突消解(纯模块,无 IO):同一股票不应在同一时间窗内既买又卖。
// 分配器在执行买入候选前调用,比较同票反向信号的相对强度后裁决:
// 放行 / 缩仓放行 / 冲突搁置 / 取消。卖出与止损永不被本模块阻断。

/** 信号档位 → 分配打分用的基准分(允许档位由 regime 参数控制,这里只管强弱) */
const TIER_SCORES = { 1: 1.0, 2: 0.75, 3: 0.35, 4: 0.15 };

export function tierScore(tier) {
  return TIER_SCORES[tier] ?? 0.15;
}

/** 信号强度 = 综合置信度 × 档位分(缺失置信度按 0.5 保守计) */
export function signalStrength({ final_confidence, confidence, tier } = {}) {
  const conf = Number.isFinite(Number(final_confidence))
    ? Number(final_confidence)
    : Number.isFinite(Number(confidence))
      ? Number(confidence)
      : 0.5;
  return conf * tierScore(tier);
}

/** 开盘首跑清扫:存在同票 pending 卖单的买入候选(应冲突搁置) */
export function sweepOpposingPairs(buyCandidates, pendingOrders) {
  const sellSymbols = new Set(
    (pendingOrders || [])
      .filter((o) => o?.side === 'sell' && (o.status === 'pending' || o.status === undefined))
      .map((o) => o.symbol)
  );
  return (buyCandidates || []).filter((c) => sellSymbols.has(c.symbol));
}

/**
 * 冲突消解(每轮分配执行前调用)。
 * - buyCandidates: 本轮拟参与排名的买入候选(candidate_signals 行)
 * - pendingSellOrders: pending_orders 中 status=pending 的卖单
 * - recentOpposingSignals: 冲突窗口内的利空分析行({ symbol, sentiment, tier,
 *   final_confidence, confidence, created_at })
 * - positions: 当前持仓;regime: 当前宏观状态名
 * 返回 { allowed, held, cancelled, reducedSize },四组互斥:
 * - 同票有 pending 卖单 → 搁置(方向已明确要离场,不与卖单抢跑);
 * - 利空明显更强(≥1.5×)且持仓 → 取消(卖出主导,买入论点已被压制);
 * - 利空明显更强但未持仓 → 搁置(留池等信号出窗后复评);
 * - 强度相当(双方均不足 1.5×)→ 搁置(方向不明,不买也不恐慌);
 * - 利好明显更强(≥1.5×):regime 非 risk_off → 缩半仓放行;risk_off → 搁置(避险下不抢方向)。
 */
export function resolveConflicts({
  buyCandidates = [],
  pendingSellOrders = [],
  recentOpposingSignals = [],
  positions = [],
  regime = 'neutral',
  cfg = {},
} = {}) {
  const dominanceRatio = cfg.dominanceRatio ?? 1.5;
  const heldSymbols = new Set((positions || []).map((p) => p.symbol));
  const sellOrderSymbols = new Set(
    (pendingSellOrders || []).filter((o) => o?.side === 'sell').map((o) => o.symbol)
  );
  const bearBySymbol = new Map();
  for (const sig of recentOpposingSignals || []) {
    if (sig?.sentiment !== 'bearish') continue;
    const strength = signalStrength(sig);
    if (strength > (bearBySymbol.get(sig.symbol) || 0)) bearBySymbol.set(sig.symbol, strength);
  }

  const allowed = [];
  const held = [];
  const cancelled = [];
  const reducedSize = [];

  for (const candidate of buyCandidates || []) {
    const symbol = candidate.symbol;
    if (sellOrderSymbols.has(symbol)) {
      held.push({ candidate, reason: '同票存在待开盘卖单,冲突搁置' });
      continue;
    }
    const bearStrength = bearBySymbol.get(symbol);
    if (!bearStrength) {
      allowed.push(candidate);
      continue;
    }
    const buyStrength = signalStrength(candidate);
    if (bearStrength >= buyStrength * dominanceRatio) {
      if (heldSymbols.has(symbol)) {
        cancelled.push({ candidate, reason: '同票利空信号明显更强且持仓在售,买入候选取消' });
      } else {
        held.push({ candidate, reason: '同票利空信号明显更强,搁置观望' });
      }
      continue;
    }
    if (buyStrength >= bearStrength * dominanceRatio) {
      if (regime === 'risk_off') {
        held.push({ candidate, reason: '利好更强但宏观避险,多空冲突一律搁置' });
      } else {
        reducedSize.push({
          candidate,
          scale: cfg.conflictScale ?? 0.5,
          reason: '同票存在较弱利空信号,缩仓放行',
        });
      }
      continue;
    }
    held.push({ candidate, reason: '同票多空信号强度相当,方向不明搁置' });
  }

  return { allowed, held, cancelled, reducedSize };
}
