import { supabase } from '../db.js';
import { getHistoricalPricesAdjusted } from './fmp.js';
import { isTradingDay } from './marketCalendar.js';
import { etMidnightUtcIso } from './riskControls.js';
import { isBrokerLedgerPrimary } from './primaryLedger.js';
import { brokerReference, loadEquityBaseline } from './brokerMirror.js';
import { fetchReferenceFills, fetchBrokerDayAnchors, loadBrokerDailyCloses } from './brokerStats.js';
import { computeRealizedFromFills } from './mirrorLedger.js';

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 时间戳 → 美东日历日(YYYY-MM-DD),交易日相关计算统一以美东时间为准 */
const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
function etDate(iso) {
  return ET_DATE_FMT.format(new Date(iso));
}

/** 全量净值快照(数据库端均匀采样;兼容未执行 002 迁移的库,失败抛错由调用方决定容忍) */
async function fetchSampledSnapshots() {
  const db = supabase();
  const since = new Date(0).toISOString();
  const { data, error } = await db.rpc('snapshots_sampled', { since, max_points: 600 });
  if (!error) return data || [];
  console.warn(`[perf] snapshots_sampled RPC 不可用(${error.message}),退回普通查询`);
  const { data: rows, error: qErr } = await db
    .from('portfolio_snapshots')
    .select('total_value, cash, positions_value, pnl, pnl_percent, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (qErr) throw new Error(qErr.message);
  return (rows || []).reverse();
}

async function fetchRecentTrades() {
  const { data, error } = await supabase()
    .from('trades')
    .select('side, realized_pnl, created_at')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * 今日盈亏的精确锚点:美东今日零点前的最后一条快照 + 全局最新一条快照。
 * 均匀采样 600 点的序列历史越长越稀,"昨日最后一条"可能偏离数小时,
 * 今日盈亏改用两条定点查询;失败返回 null(调用方退回采样序列口径)。
 */
async function fetchDayPnlAnchors() {
  const db = supabase();
  const midnight = etMidnightUtcIso();
  const pick = (res) => (res.error ? null : res.data?.[0] || null);
  const [baseRes, lastRes] = await Promise.all([
    db
      .from('portfolio_snapshots')
      .select('total_value, created_at')
      .lt('created_at', midnight)
      .order('created_at', { ascending: false })
      .limit(1),
    db
      .from('portfolio_snapshots')
      .select('total_value, created_at')
      .order('created_at', { ascending: false })
      .limit(1),
  ]);
  const baseline = pick(baseRes);
  const latest = pick(lastRes);
  if (!baseline || !latest) return null;
  return { baseline, latest };
}

/** 组合统计(今日盈亏、已实现盈亏、胜率、最大回撤),纯计算 */
function computeStats(trades, snaps, anchors = null) {
  const sells = trades.filter((t) => t.side === 'sell' && t.realized_pnl !== null);
  const realizedPnl = sells.reduce((sum, t) => sum + Number(t.realized_pnl), 0);
  const wins = sells.filter((t) => Number(t.realized_pnl) > 0).length;

  // 最大回撤(基于采样后的净值序列;600 点均匀采样,历史很长时峰谷可能被抹掉,
  // 属展示层可接受的近似——精确回撤需要全量快照遍历,成本不成比例)
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const s of snaps) {
    const v = Number(s.total_value);
    if (v > peak) peak = v;
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, ((peak - v) / peak) * 100);
  }

  // 今日盈亏:优先用定点查询的精确锚点(美东今日零点前最后一条 vs 全局最新一条),
  // 锚点不可用时退回采样序列推算
  const today = etDate(new Date().toISOString());
  let baseline = anchors?.baseline || null;
  let latest = anchors?.latest || null;
  if (!baseline || !latest) {
    baseline = null;
    for (const s of snaps) {
      if (etDate(s.created_at) < today) baseline = s;
      else break;
    }
    latest = snaps[snaps.length - 1] || null;
  }
  const dayPnl =
    latest && baseline ? Number(latest.total_value) - Number(baseline.total_value) : null;
  const dayPnlPercent =
    dayPnl !== null && Number(baseline.total_value) > 0
      ? (dayPnl / Number(baseline.total_value)) * 100
      : null;

  return {
    total_trades: trades.length,
    sell_count: sells.length,
    win_count: wins,
    win_rate: sells.length ? (wins / sells.length) * 100 : null,
    realized_pnl: realizedPnl,
    max_drawdown_percent: maxDrawdown,
    day_pnl: dayPnl,
    day_pnl_percent: dayPnlPercent,
  };
}

/**
 * 券商主账本(024/030)下的统计输入:全部换成参照账户的镜像数据 ——
 * 净值序列 = 日度收盘回走 + 最新快照,成交 = 镜像成交按加权均价重放出已实现盈亏。
 * 任何一步失败向上抛,由调用方限频告警后回退内部口径。
 */
async function fetchBrokerStatsInputs() {
  const ref = brokerReference();
  if (!ref) throw new Error('券商参照账户不可用');
  const [fills, anchors, dailyRows, baseline] = await Promise.all([
    fetchReferenceFills(ref),
    fetchBrokerDayAnchors(ref),
    loadBrokerDailyCloses(ref),
    loadEquityBaseline(ref),
  ]);
  const { realizedById } = computeRealizedFromFills(fills);
  const tradeRows = fills.map((f) => ({
    side: f.side,
    realized_pnl: f.side === 'sell' ? (realizedById.get(f.id) ?? null) : null,
  }));
  let snapRows = dailyRows.map((d) => ({ total_value: d.value, created_at: d.created_at }));
  // 最新实时快照并入序列尾(当日回撤/最新净值不缺席);回走的最新一天通常就是它,按时间去重
  const latest = anchors?.latest || null;
  const tail = snapRows[snapRows.length - 1] || null;
  if (latest && (!tail || Date.parse(latest.created_at) > Date.parse(tail.created_at))) {
    snapRows = [...snapRows, latest];
  }
  return { tradeRows, anchors, snapRows, baseline };
}

// 券商侧统计取数失败的限频告警(与 primaryLedger 的回退告警同一节奏)
let lastBrokerStatsWarnAt = 0;
function warnBrokerStatsFallback(err) {
  if (Date.now() - lastBrokerStatsWarnAt > 5 * 60_000) {
    lastBrokerStatsWarnAt = Date.now();
    console.warn(`[perf] 券商侧统计取数失败,回退内部口径: ${err.message}`);
  }
}

/** /api/stats 的数据来源(行为与原内联实现一致:快照不可用时容忍为空) */
export async function getStats() {
  if (isBrokerLedgerPrimary()) {
    try {
      const b = await fetchBrokerStatsInputs();
      return { ...computeStats(b.tradeRows, b.snapRows, b.anchors), ledger: 'broker' };
    } catch (err) {
      warnBrokerStatsFallback(err);
    }
  }
  const [trades, snaps, anchors] = await Promise.all([
    fetchRecentTrades(),
    fetchSampledSnapshots().catch(() => []),
    fetchDayPnlAnchors().catch(() => null),
  ]);
  return { ...computeStats(trades, snaps, anchors), ledger: 'internal' };
}

/**
 * 净值按美东日历日重采样(取每日最后一条快照),并过滤到实际交易日。
 * 快照在盘中每分钟一条、休市每 30 分钟一条,频率不均,
 * 夏普等指标必须基于等间隔的日度序列计算;周末/假日的快照若不过滤,
 * 会变成收益≈0 的伪交易日,人为压低波动率、抬高年化(√252)夏普。
 */
function toDailySeries(snaps) {
  const byDay = new Map();
  for (const s of snaps) {
    const date = etDate(s.created_at);
    if (!isTradingDay(date)) continue;
    byDay.set(date, Number(s.total_value));
  }
  return [...byDay.entries()].map(([date, value]) => ({ date, value }));
}

/** 年化夏普比率(无风险利率按 0 简化)。日度点数不足或波动为零时返回 null */
function computeSharpe(daily) {
  if (daily.length < 3) return null;
  const returns = [];
  for (let i = 1; i < daily.length; i++) {
    const prev = daily[i - 1].value;
    if (prev > 0) returns.push(daily[i].value / prev - 1);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (!Number.isFinite(std) || std <= 0) return null;
  return (mean / std) * Math.sqrt(252);
}

/** 净值走势图的参考基线:标普500(SPY)与黄金(GLD),均按"同期买入持有"口径 */
const BENCHMARKS = [
  { symbol: 'SPY', name: '标普500' },
  { symbol: 'GLD', name: '黄金' },
];

/**
 * 买入持有基准:从首个快照日到今天,按初始资金归一化。
 * 用股息调整后的总回报序列(股息再投资),与策略的"全部盈亏都体现在净值里"
 * 口径一致;调整端点不可用时回退纯价格序列,basis 标记为 'price'。
 */
async function getBenchmark({ symbol, name }, daily, initialCapital) {
  if (!daily.length || !initialCapital) return null;
  const from = daily[0].date;
  const to = etDate(new Date().toISOString());
  const { rows: prices, adjusted } = await getHistoricalPricesAdjusted(symbol, from, to);
  if (prices.length < 2) return null;

  const base = prices[0].price;
  const series = prices.map((p) => ({
    date: p.date,
    close: p.price,
    value: round2(initialCapital * (p.price / base)),
  }));
  return {
    symbol,
    name,
    basis: adjusted ? 'total_return' : 'price',
    series,
    cumulative_return_percent: (prices[prices.length - 1].price / base - 1) * 100,
  };
}

/** 业绩载荷组装(内部/券商两条路径公用):夏普、累计收益率、基准对比,输入决定口径 */
async function buildPerformance({ stats, snaps, initialCapital }) {
  const daily = toDailySeries(snaps);

  const latest = snaps[snaps.length - 1] || null;
  const cumulativeReturn =
    latest && initialCapital
      ? ((Number(latest.total_value) - initialCapital) / initialCapital) * 100
      : null;

  // 基准拉取失败(数据源限额/网络)不应影响其余指标,单个基准失败也不影响其余基准
  const benchmarks = (
    await Promise.all(
      BENCHMARKS.map((b) =>
        getBenchmark(b, daily, initialCapital).catch((err) => {
          console.warn(`[perf] 获取 ${b.symbol} 基准失败: ${err.message}`);
          return null;
        })
      )
    )
  ).filter(Boolean);

  // benchmark 字段保持旧形状(SPY + 超额收益),供累计收益率卡片等存量消费方使用
  const spy = benchmarks.find((b) => b.symbol === 'SPY') || null;

  return {
    ...stats,
    sharpe_ratio: computeSharpe(daily),
    cumulative_return_percent: cumulativeReturn,
    trading_days: daily.length,
    benchmark: spy
      ? {
          ...spy,
          excess_return_percent:
            cumulativeReturn !== null
              ? cumulativeReturn - spy.cumulative_return_percent
              : null,
        }
      : null,
    benchmarks,
  };
}

/**
 * 业绩指标:夏普比率、累计收益率、最大回撤、胜率 + SPY 买入持有基准对比。
 * 数据不足时各指标为 null(账户运行不满 3 个交易日算不出夏普),前端显示「数据不足」。
 * 券商主账本下整套指标切到参照账户口径:初始资金 = 最早一条镜像快照净值,
 * 净值序列/成交均为镜像数据;失败限频告警后回退内部账本。
 */
export async function getPerformance() {
  if (isBrokerLedgerPrimary()) {
    try {
      const b = await fetchBrokerStatsInputs();
      const stats = computeStats(b.tradeRows, b.snapRows, b.anchors);
      const initialCapital = Number(b.baseline) > 0 ? Number(b.baseline) : null;
      const payload = await buildPerformance({ stats, snaps: b.snapRows, initialCapital });
      return { ...payload, ledger: 'broker' };
    } catch (err) {
      warnBrokerStatsFallback(err);
    }
  }
  const db = supabase();
  const [trades, snaps, anchors, stateRes] = await Promise.all([
    fetchRecentTrades(),
    fetchSampledSnapshots().catch(() => []),
    fetchDayPnlAnchors().catch(() => null),
    db.from('portfolio_state').select('initial_capital').eq('id', 1).maybeSingle(),
  ]);

  const stats = computeStats(trades, snaps, anchors);
  const initialCapital = Number(stateRes.data?.initial_capital) || null;
  const payload = await buildPerformance({ stats, snaps, initialCapital });
  return { ...payload, ledger: 'internal' };
}
