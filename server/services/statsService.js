import { supabase } from '../db.js';
import { getHistoricalPricesAdjusted } from './fmp.js';
import { isTradingDay } from './marketCalendar.js';
import { etMidnightUtcIso } from './riskControls.js';

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

/** /api/stats 的数据来源(行为与原内联实现一致:快照不可用时容忍为空) */
export async function getStats() {
  const [trades, snaps, anchors] = await Promise.all([
    fetchRecentTrades(),
    fetchSampledSnapshots().catch(() => []),
    fetchDayPnlAnchors().catch(() => null),
  ]);
  return computeStats(trades, snaps, anchors);
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

/**
 * 业绩指标:夏普比率、累计收益率、最大回撤、胜率 + SPY 买入持有基准对比。
 * 数据不足时各指标为 null(账户运行不满 3 个交易日算不出夏普),前端显示「数据不足」。
 */
export async function getPerformance() {
  const db = supabase();
  const [trades, snaps, anchors, stateRes] = await Promise.all([
    fetchRecentTrades(),
    fetchSampledSnapshots().catch(() => []),
    fetchDayPnlAnchors().catch(() => null),
    db.from('portfolio_state').select('initial_capital').eq('id', 1).maybeSingle(),
  ]);

  const stats = computeStats(trades, snaps, anchors);
  const initialCapital = Number(stateRes.data?.initial_capital) || null;
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
