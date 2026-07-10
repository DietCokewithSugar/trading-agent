/**
 * 镜像账本纯逻辑(券商主账本的统计与交易记录口径,024/030):
 * - computeRealizedFromFills:按时间重放参照账户的镜像成交,加权平均成本口径
 *   (与内部账本一致)得出每笔卖出的已实现盈亏——broker_mirror_orders 没有
 *   realized_pnl 列,只能由成交序列推导;
 * - fillsToTrades:镜像成交行映射为内部 trades 行形状,交易页/最近交易零改动消费。
 * 纯函数、零依赖;IO(取数/分页/meta 关联)在 brokerStats.js。
 */

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** fill 的时间锚点:成交时间优先,缺失退回提交时间(submitted_at 非空,兜底空串) */
function fillTime(row) {
  return row.filled_at ?? row.submitted_at ?? '';
}

/** 排序用毫秒时间戳:DB 的 +00:00 与前端的 Z 两种 ISO 变体不能直接字符串比较 */
function fillTimeMs(row) {
  const t = Date.parse(fillTime(row));
  return Number.isFinite(t) ? t : 0;
}

/** 只保留真正成交的行(部分成交按 filled_qty 计,零成交/畸形行剔除) */
function usableFills(fills) {
  return (fills || []).filter(
    (f) => f && (f.side === 'buy' || f.side === 'sell') && toNum(f.filled_qty) > 0 && toNum(f.filled_avg_price) !== null
  );
}

/**
 * 重放成交序列,推导每笔卖出的已实现盈亏。
 * 排序键 (成交时间, id):id 为自增主键,同一时刻按落库顺序稳定重放。
 * 无在册持仓基础的卖出(对账单/清仓单/入册前的历史仓位)realized 记 null——
 * 与 statsService#computeStats 过滤 realized_pnl === null 的口径天然一致,不计入胜率;
 * 超量卖出只对在册部分(covered)计盈亏。
 * @returns {{ realizedById: Map<any, number|null>, totals: { realized_pnl: number, sell_count: number, win_count: number } }}
 */
export function computeRealizedFromFills(fills) {
  const rows = usableFills(fills).sort(
    (a, b) => fillTimeMs(a) - fillTimeMs(b) || (a.id ?? 0) - (b.id ?? 0)
  );

  const book = new Map(); // symbol → { qty, avg }
  const realizedById = new Map();
  const totals = { realized_pnl: 0, sell_count: 0, win_count: 0 };

  for (const f of rows) {
    const qty = toNum(f.filled_qty);
    const price = toNum(f.filled_avg_price);
    const pos = book.get(f.symbol) || { qty: 0, avg: 0 };
    if (f.side === 'buy') {
      const newQty = pos.qty + qty;
      pos.avg = (pos.qty * pos.avg + qty * price) / newQty;
      pos.qty = newQty;
      book.set(f.symbol, pos);
      continue;
    }
    const covered = Math.min(qty, pos.qty);
    if (covered > 0) {
      const realized = round2((price - pos.avg) * covered);
      realizedById.set(f.id, realized);
      totals.realized_pnl = round2(totals.realized_pnl + realized);
      totals.sell_count += 1;
      if (realized > 0) totals.win_count += 1;
      pos.qty -= covered;
      if (pos.qty <= 1e-9) {
        pos.qty = 0;
        pos.avg = 0;
      }
      book.set(f.symbol, pos);
    } else {
      realizedById.set(f.id, null);
    }
  }
  return { realizedById, totals };
}

/**
 * 镜像成交行 → 内部 trades 行形状(按时间倒序返回)。
 * id 加 bm- 前缀命名空间化:镜像单与内部交易是两条独立自增序列,
 * 交易页按 id 去重,主账本切换瞬间两侧行短暂共存时不能撞号。
 * meta 来自镜像单 trade_id 关联的内部交易(触发方式/决策依据/关联新闻);
 * 对账/清仓单无 trade_id → 全部为 null。
 */
export function fillsToTrades(fills, { realizedById = new Map(), metaById = new Map() } = {}) {
  const sorted = usableFills(fills).sort(
    (a, b) => fillTimeMs(b) - fillTimeMs(a) || (b.id ?? 0) - (a.id ?? 0)
  );
  return sorted.map((f) => {
    const qty = toNum(f.filled_qty);
    const price = toNum(f.filled_avg_price);
    const meta = (f.trade_id !== null && f.trade_id !== undefined && metaById.get(f.trade_id)) || null;
    return {
      id: `bm-${f.id}`,
      trade_id: f.trade_id ?? null,
      created_at: fillTime(f) || null,
      side: f.side,
      symbol: f.symbol,
      quantity: qty,
      price,
      amount: round2(qty * price),
      realized_pnl: f.side === 'sell' ? (realizedById.get(f.id) ?? null) : null,
      trigger: meta?.trigger ?? null,
      reason: meta?.reason ?? null,
      macro_regime: meta?.macro_regime ?? null,
      news_articles: meta?.news_articles ?? null,
      news_analyses: meta?.news_analyses ?? null,
      ledger: 'broker',
    };
  });
}
