/**
 * 券商主账本的统计取数层(030):参照账户(管理页主对照账户优先,否则 env 默认账户)
 * 维度的镜像快照/镜像成交读取,供 statsService(关键指标)与 /api/trades(交易记录)
 * 在 broker_ledger_primary 开启时替换内部账本数据源。
 * 纯数学在 mirrorLedger.js;本模块只做 IO、分页与进程内缓存。
 * 任何取数失败向上抛,由调用方限频告警后回退内部口径(fail-open)。
 */
import { supabase } from '../db.js';
import {
  brokerReference,
  referenceSnapshotQuery,
  referenceOrdersQuery,
} from './brokerMirror.js';
import { etMidnightUtcIso, etDayRangeUtc } from './riskControls.js';
import { etDayKey } from './metrics.js';
import { computeRealizedFromFills, fillsToTrades } from './mirrorLedger.js';

const FILLS_COLUMNS = 'id, trade_id, symbol, side, qty, filled_qty, filled_avg_price, filled_at, submitted_at';
// 全量成交上限:统计与已实现盈亏重放需要完整成本基础,实际账户量级为数百行,
// 每次请求全量取回可接受;命中上限意味着最早的成本基础缺失,告警一次(近似可接受)
const FILLS_MAX = 5000;
// 日度收盘回走上限:冷启动最多回看的日历天数(夏普/回撤的展示层窗口足够)
const DAILY_MAX_DAYS = 120;

let fillsCapWarned = false;

/** 参照账户的全部镜像成交(filled_qty>0,升序返回;部分成交/重试子单都是独立 fill) */
export async function fetchReferenceFills(ref) {
  const { data, error } = await referenceOrdersQuery(ref, FILLS_COLUMNS, {
    apply: (q) => q.gt('filled_qty', 0).order('submitted_at', { ascending: false }).limit(FILLS_MAX),
  });
  if (error) throw new Error(error.message);
  const rows = data || [];
  if (rows.length >= FILLS_MAX && !fillsCapWarned) {
    fillsCapWarned = true;
    console.warn(`[broker] 镜像成交超过 ${FILLS_MAX} 行上限,最早的成本基础可能缺失(统计为近似值)`);
  }
  return rows.reverse();
}

/**
 * 今日盈亏锚点(与 statsService#fetchDayPnlAnchors 同构,换成参照账户的镜像快照):
 * 美东今日零点前最后一条 + 全局最新一条;缺任一返回 null(调用方退回序列口径)。
 */
export async function fetchBrokerDayAnchors(ref) {
  const toAnchor = (res) => {
    const row = res.error ? null : res.data?.[0] || null;
    if (!row) return null;
    const equity = Number(row.equity);
    return Number.isFinite(equity) ? { total_value: equity, created_at: row.created_at } : null;
  };
  const [baseRes, lastRes] = await Promise.all([
    referenceSnapshotQuery(ref, 'equity, created_at', {
      ascending: false,
      limit: 1,
      ltCreatedAt: etMidnightUtcIso(),
    }),
    referenceSnapshotQuery(ref, 'equity, created_at', { ascending: false, limit: 1 }),
  ]);
  const baseline = toAnchor(baseRes);
  const latest = toAnchor(lastRes);
  if (!baseline || !latest) return null;
  return { baseline, latest };
}

// 日度收盘缓存(按参照账户隔离,参照切换即时失效):已结束交易日的收盘不可变,
// 只有最新一天会被后续快照覆盖更新
let dailyCache = { key: null, byDate: new Map() };

/**
 * 参照账户的日度收盘净值序列(夏普/回撤用)。30s 快照粒度下全量取数不可行
 * (数千行/交易日),改为按日回走定点查询:游标自当前向过去,每步取游标前最后
 * 一条快照(即该美东日的收盘),游标退到该日零点再走。冷启动 O(有数据天数) 次
 * 定点查询(封顶 DAILY_MAX_DAYS),此后每次调用只更新最新一两天(命中缓存即停)。
 * 返回升序 [{ date, value, created_at }](保留真实时间戳,toDailySeries 的
 * 美东日期换算/交易日过滤才正确)。
 */
export async function loadBrokerDailyCloses(ref) {
  if (dailyCache.key !== ref.key) dailyCache = { key: ref.key, byDate: new Map() };
  const byDate = dailyCache.byDate;
  let cursor = null;
  for (let i = 0; i < DAILY_MAX_DAYS; i++) {
    const { data, error } = await referenceSnapshotQuery(ref, 'equity, created_at', {
      ascending: false,
      limit: 1,
      ltCreatedAt: cursor,
    });
    if (error) throw new Error(error.message);
    const row = data?.[0];
    if (!row) break; // 走到数据起点
    const equity = Number(row.equity);
    const date = etDayKey(new Date(row.created_at));
    const cached = byDate.get(date);
    // 命中缓存(同一条收盘快照):更早的日收盘均不可变,无需继续回走
    if (cached && cached.created_at === row.created_at) break;
    if (Number.isFinite(equity)) byDate.set(date, { date, value: equity, created_at: row.created_at });
    const range = etDayRangeUtc(date);
    if (!range) break;
    cursor = range.startIso;
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 管理重置/参照账户注销时清空进程内缓存 */
export function clearBrokerStatsCache() {
  dailyCache = { key: null, byDate: new Map() };
  fillsCapWarned = false;
}

/**
 * /api/trades 的券商主账本数据源:参照账户镜像成交映射为内部 trades 行形状。
 * 已实现盈亏与 /api/stats 共用同一次全量重放(computeRealizedFromFills),
 * 两处口径必然一致;分页后仅对当页行的 trade_id 批量取内部交易 meta
 * (触发方式/决策依据/关联新闻),meta 取数失败只降级为空,不整体失败。
 */
export async function listBrokerTrades({ limit = 100, offset = 0, before = null } = {}) {
  const ref = brokerReference();
  if (!ref) throw new Error('券商参照账户不可用');
  const fills = await fetchReferenceFills(ref);
  const { realizedById } = computeRealizedFromFills(fills);
  const all = fillsToTrades(fills, { realizedById });

  const beforeMs = before ? Date.parse(before) : NaN;
  const page = Number.isFinite(beforeMs)
    ? all.filter((t) => Date.parse(t.created_at) < beforeMs).slice(0, limit)
    : all.slice(offset, offset + limit);

  const ids = [...new Set(page.map((t) => t.trade_id).filter((v) => v !== null && v !== undefined))];
  let metaById = new Map();
  if (ids.length) {
    try {
      const { data, error } = await supabase()
        .from('trades')
        .select('id, trigger, reason, macro_regime, news_articles(title, url), news_analyses(sentiment, tier, reasoning)')
        .in('id', ids);
      if (error) throw new Error(error.message);
      metaById = new Map((data || []).map((t) => [t.id, t]));
    } catch (err) {
      console.warn(`[broker] 镜像成交关联内部交易 meta 失败(降级为空): ${err.message}`);
    }
  }
  return page.map((row) => {
    const meta = metaById.get(row.trade_id);
    return meta
      ? {
          ...row,
          trigger: meta.trigger ?? null,
          reason: meta.reason ?? null,
          macro_regime: meta.macro_regime ?? null,
          news_articles: meta.news_articles ?? null,
          news_analyses: meta.news_analyses ?? null,
        }
      : row;
  });
}
