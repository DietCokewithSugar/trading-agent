// 券商镜像单跟进策略(027,纯函数,node:test 直接测):
// 021 的镜像单是当日限价单,过期即永久放弃 —— 卖单未成交会在券商账户滞留孤儿持仓,
// 买单未成交则券商侧永远没建仓。本模块把"未成交之后怎么办"收敛成纯决策逻辑:
//  - 休市顺延(deferred):开盘后以实时价挂单,不再用过期报价挂必死单;
//  - 卖单必须收敛:限价重挂 maxRetries 次后升级一次市价单(盘外提交排队到下一常规时段);
//  - 买单限时追单(buyRetry='chase'):漂移(相对原内部成交价,只限上行)超 buyDriftCapPercent
//    或次数用尽即放弃 —— 不以离谱价格追高污染对照数据;
//  - 对账清理(planReconcile):券商持有但内部账本已不持有的仓位 → 平掉(永不买入对账)。
// IO(券商持仓定量、报价、落库)全部留在 brokerMirror.js。

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** marketable 限价:买 = 基准价 ×(1+slack%),卖 = ×(1−slack%);非法入参返回 null */
export function mirrorLimitPrice({ side, price, slackPercent }) {
  const p = Number(price);
  const s = Number(slackPercent);
  if (!(p > 0) || !Number.isFinite(s) || s < 0) return null;
  const factor = side === 'sell' ? 1 - s / 100 : 1 + s / 100;
  return round2(p * factor);
}

/** 未成交余量:qty − filled_qty,null 安全,下限 0 */
export function remainingQty({ qty, filledQty }) {
  const q = Number(qty);
  if (!(q > 0)) return 0;
  const f = Number(filledQty);
  return Math.max(q - (f > 0 ? f : 0), 0);
}

/** 重挂幂等键:剥掉尾部 -rN 再拼 -r{attempt}(trade-12 → trade-12-r2;shadow-9-a5-r2 → shadow-9-a5-r3) */
export function nextRetryClientOrderId(clientOrderId, attempt) {
  const root = String(clientOrderId || '').replace(/-r\d+$/, '');
  return `${root}-r${attempt}`;
}

/** 买单追价漂移(%):实时价相对原内部成交价的带符号偏移;非法入参返回 null */
export function buyDriftPercent({ internalPrice, currentPrice }) {
  const internal = Number(internalPrice);
  const current = Number(currentPrice);
  if (!(internal > 0) || !(current > 0)) return null;
  return ((current - internal) / internal) * 100;
}

/**
 * 镜像单跟进决策。两个入口场景:
 *  - row.status==='deferred':休市顺延单,session/实时价决定 等待/提交/放弃;
 *  - 在途单迁移到终态:brokerStatus ∈ expired/canceled/rejected 时决定 重挂/升级/放弃。
 * 返回 { action, qty?, limitPrice?, orderType?, extendedHours?, note? }:
 *  action ∈ wait(本轮跳过,下轮重放)| submit_deferred | retry_limit | retry_defer(休市,
 *  子行先落 deferred)| market_escalate | abandon(顺延买单漂移超限)| none(不跟进)。
 * 卖出数量不在此定(需查券商持仓,IO),调用方按 adjustSellQty 重定。
 */
export function planMirrorFollowUp({ row, brokerStatus = null, session = null, currentPrice = null, config = {} }) {
  const side = row?.side;
  const slack = Number(config.slackPercent) >= 0 ? Number(config.slackPercent) : 1;
  const maxRetries = Number.isFinite(Number(config.maxRetries)) ? Math.max(Number(config.maxRetries), 0) : 3;
  const driftCap = Number.isFinite(Number(config.buyDriftCapPercent)) ? Number(config.buyDriftCapPercent) : 5;
  const attempt = Number(row?.attempt) > 0 ? Number(row.attempt) : 1;
  const price = Number(currentPrice) > 0 ? Number(currentPrice) : null;

  // ── 休市顺延单:开盘后以实时价提交 ──
  if (row?.status === 'deferred') {
    if (session === 'closed' || !price) return { action: 'wait' };
    if (side === 'buy') {
      const drift = buyDriftPercent({ internalPrice: row.internal_price, currentPrice: price });
      if (drift === null) return { action: 'wait' };
      if (drift > driftCap) {
        return { action: 'abandon', note: `开盘漂移 +${drift.toFixed(1)}% 超限,放弃顺延买单` };
      }
    }
    return {
      action: 'submit_deferred',
      limitPrice: mirrorLimitPrice({ side, price, slackPercent: slack }),
      extendedHours: session !== 'regular',
    };
  }

  // ── 在途单终态迁移:决定是否重挂 ──
  if (!['expired', 'canceled', 'rejected'].includes(brokerStatus)) return { action: 'none' };
  const remainder = remainingQty({ qty: row?.qty, filledQty: row?.filled_qty });
  if (!(remainder > 0)) return { action: 'none' };

  if (side === 'sell') {
    // 卖出必须收敛(否则券商账户滞留孤儿持仓):限价重挂后升级一次市价单;
    // rejected 同样跟进 —— 收敛优先,注定失败的重挂只会再次终态,由对账清理兜底
    if (attempt <= maxRetries) {
      if (session === 'closed') {
        return { action: 'retry_defer', qty: remainder, note: `已顺延重挂第 ${attempt + 1} 次` };
      }
      if (!price) return { action: 'wait' };
      return {
        action: 'retry_limit',
        qty: remainder,
        limitPrice: mirrorLimitPrice({ side: 'sell', price, slackPercent: slack }),
        extendedHours: session !== 'regular',
        note: `已重挂第 ${attempt + 1} 次`,
      };
    }
    if (attempt === maxRetries + 1) {
      // 市价单不允许 extended_hours;盘外/休市提交自动排队到下一常规时段(必然成交)
      return { action: 'market_escalate', qty: remainder, extendedHours: false, note: '限价重挂未果,升级市价单' };
    }
    return { action: 'none', note: '市价单亦未收敛,待对账清理兜底' };
  }

  // 买单:券商拒单(买力/标的状态)通常非瞬态,不追;追单可整体关闭
  if (brokerStatus === 'rejected') return { action: 'none', note: '券商拒单,买单不重挂' };
  if (config.buyRetry === 'off') return { action: 'none' };
  if (attempt > maxRetries) return { action: 'none', note: '重挂次数用尽,放弃追单' };
  if (session === 'closed') {
    return { action: 'retry_defer', qty: remainder, note: `已顺延追单第 ${attempt + 1} 次` };
  }
  if (!price) return { action: 'wait' };
  const drift = buyDriftPercent({ internalPrice: row?.internal_price, currentPrice: price });
  if (drift === null) return { action: 'wait' };
  // 只限上行:向下跳空 = 比内部账本更便宜建仓,严格有利,不设上限
  if (drift > driftCap) {
    return { action: 'none', note: `放弃追单(漂移 +${drift.toFixed(1)}% 超限)` };
  }
  return {
    action: 'retry_limit',
    qty: remainder,
    limitPrice: mirrorLimitPrice({ side: 'buy', price, slackPercent: slack }),
    extendedHours: session !== 'regular',
    note: `已追单第 ${attempt + 1} 次`,
  };
}

/**
 * 对账清理计划:券商持仓 vs 内部账本持仓,返回该平掉的 [{ symbol, qty, reason }]。
 *  - 券商独有(内部已卖出/从未持有)→ 全平(reason 'orphan');
 *  - 券商超额 > dustQty(部分成交漂移)→ 卖出超额(reason 'excess');
 *  - 有在途镜像单的 symbol 跳过(重挂机制正在收敛);内部独有 → 忽略(永不买入对账,
 *    买侧分歧由挂单时的追单策略负责,清理时点补买等于按过期论点建仓)。
 * brokerPositions 为券商持仓行(qty_available 优先,锁在未成交单里的股数不可卖),
 * internalPositions 为 positions 表行({ symbol, quantity })。
 */
export function planReconcile({ brokerPositions, internalPositions, inflightSymbols, dustQty = 0.01 }) {
  const inflight = new Set((inflightSymbols || []).map((s) => String(s).toUpperCase()));
  const internal = new Map();
  for (const p of internalPositions || []) {
    const sym = String(p?.symbol || '').toUpperCase();
    const q = Number(p?.quantity);
    if (sym && Number.isFinite(q) && q > 0) internal.set(sym, (internal.get(sym) || 0) + q);
  }
  const out = [];
  for (const bp of brokerPositions || []) {
    const sym = String(bp?.symbol || '').toUpperCase();
    if (!sym || inflight.has(sym)) continue;
    const have = Number(bp?.qty_available ?? bp?.qty);
    if (!(have > 0)) continue;
    const want = internal.get(sym) || 0;
    const excess = have - want;
    if (excess <= dustQty) continue;
    out.push(
      want > 0
        ? { symbol: sym, qty: Math.round(excess * 10000) / 10000, reason: 'excess' }
        : { symbol: sym, qty: have, reason: 'orphan' }
    );
  }
  return out;
}
