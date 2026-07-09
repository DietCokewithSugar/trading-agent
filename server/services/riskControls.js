import { supabase } from '../db.js';
import { config } from '../config.js';
import { etDayKey } from './metrics.js';

/**
 * 组合级硬风控(代码强制,先于且独立于 LLM 风控官;只约束买入,卖出/止损永远放行):
 * - 当日亏损熔断:当日组合亏损达到阈值 → 当日停止开新仓(sticky,次日自动恢复);
 * - 最大持仓数:开新仓受限,加仓不受限;
 * - 行业集中度:买后单行业市值占比超限时钳制买入金额;
 * - 连亏降仓:最近 N 笔卖出全亏 → 买入比例打折。
 * 上半部为纯函数(node:test 直接测),下半部为带进程内状态/DB 查询的薄层。
 * 熔断触发状态与当日基线缓存均在进程内,重启清零(可接受:基线随即重查,
 * 熔断会在下一次买入检查时按当日盈亏重新判定;人工 kill switch 已持久化兜底)。
 */

// ===== 纯函数 =====

/** 任意美东日历日('YYYY-MM-DD')的零点 UTC 时刻;非法输入返回 null(EST/EDT 偏移试探) */
function etMidnightForDayKey(dayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey ?? ''))) return null;
  for (const offset of ['-05:00', '-04:00']) {
    const candidate = new Date(`${dayKey}T00:00:00${offset}`);
    if (Number.isNaN(candidate.getTime())) continue;
    if (etDayKey(candidate) === dayKey) {
      const hour = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(candidate);
      if (Number(hour) === 0) return candidate;
    }
  }
  return null;
}

/**
 * 美东今日零点对应的 UTC 时刻(ISO)。分别尝试 EST(-05:00)/EDT(-04:00)两个偏移,
 * 取换算回美东后日历日仍为今日且小时为 0 的那个,DST 边界安全。
 */
export function etMidnightUtcIso(now = new Date()) {
  const dayKey = etDayKey(now);
  const midnight = etMidnightForDayKey(dayKey);
  // 理论不可达的兜底:按 EST 计
  return (midnight ?? new Date(`${dayKey}T00:00:00-05:00`)).toISOString();
}

/**
 * 美东日历日 dayKey('YYYY-MM-DD')对应的 UTC 时间范围 [startIso, endIso)。
 * endIso 用"日历日 +1 再算零点"(不能 startIso+24h:DST 切换日是 23/25 小时)。
 * 非法/不存在的日期返回 null。新闻页服务端单日筛选用。
 */
export function etDayRangeUtc(dayKey) {
  const start = etMidnightForDayKey(dayKey);
  if (!start) return null;
  const [y, m, d] = String(dayKey).split('-').map(Number);
  const nextKey = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const end = etMidnightForDayKey(nextKey);
  if (!end) return null;
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/** 当日盈亏百分比 = (当前总值 − 日初基线)/基线;任一输入无效(非正数)返回 null */
export function computeDayPnlPercent(totalValue, baselineValue) {
  const total = Number(totalValue);
  const base = Number(baselineValue);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(base) || base <= 0) return null;
  return ((total - base) / base) * 100;
}

/**
 * 当日亏损熔断状态机:换日重置;已触发当日保持(sticky,盘中反弹也不恢复——
 * 熔断的意义是"今天判断系统性失准,停手");亏损达到阈值触发。
 * thresholdPercent=0 关闭;dayPnlPercent=null(基线不可得)不触发(fail-open)。
 */
export function updateDailyLossState(state, { dayKey, dayPnlPercent, thresholdPercent }) {
  const tripped = state?.dayKey === dayKey ? Boolean(state.tripped) : false;
  if (tripped) return { dayKey, tripped: true };
  const trip =
    thresholdPercent > 0 && dayPnlPercent !== null && dayPnlPercent <= -thresholdPercent;
  return { dayKey, tripped: trip };
}

/** 最大持仓数:开新仓受限,已持有(加仓)永远放行;maxOpenPositions=0 关闭 */
export function checkMaxPositions({ positions, symbol, maxOpenPositions }) {
  if (!(maxOpenPositions > 0)) return { ok: true };
  const held = (positions || []).some((p) => p.symbol === symbol);
  if (held) return { ok: true };
  if ((positions || []).length >= maxOpenPositions) {
    return { ok: false, reason: `持仓数已达上限 ${maxOpenPositions},不再开新仓` };
  }
  return { ok: true };
}

/**
 * 行业集中度的剩余可买额度。买入是现金 → 持仓的内部转换,买后组合总值不变,
 * 买后行业权重 = (行业现值 + spend) / 总值,故 headroom = cap × 总值 − 行业现值。
 * maxSectorFraction=0 关闭(返回 Infinity)。
 */
export function sectorCapHeadroom({ totalValue, sectorValue, maxSectorFraction }) {
  if (!(maxSectorFraction > 0)) return Infinity;
  const total = Number(totalValue) || 0;
  const sector = Number(sectorValue) || 0;
  return Math.max(maxSectorFraction * total - sector, 0);
}

/**
 * 连亏降仓乘数:pnls 为按时间倒序的最近卖出 realized_pnl;
 * 样本满 count 笔且全部亏损 → 返回 scale,否则 1。count=0 或 scale>=1 关闭。
 */
export function lossStreakMultiplier(pnls, { count, scale }) {
  if (!(count > 0) || !(scale < 1)) return 1;
  const recent = (pnls || []).slice(0, count);
  if (recent.length < count) return 1;
  return recent.every((p) => Number(p) < 0) ? scale : 1;
}

/**
 * 宏观环境三重买入钳制(014):现金保留下限 / 当日买入预算 / 持仓总敞口上限。
 * spend 为拟买金额;budgetBase 为当日预算基数(日初组合总值,缺失时退用当前总值);
 * params 取自 config.macroRegimeParams[regime]。
 * 返回 { spend: 钳制后金额(≥0), clamped, binding }(binding 为最早把额度压到最低的约束名,
 * 'cash_reserve' | 'daily_budget' | 'gross_exposure' | null)。
 */
export function computeBuyHeadroom({
  spend,
  cash,
  totalValue,
  positionsValue,
  spentToday = 0,
  budgetBase = null,
  params = {},
}) {
  const want = Math.max(Number(spend) || 0, 0);
  const total = Number(totalValue) || 0;
  const base = Number.isFinite(Number(budgetBase)) && Number(budgetBase) > 0 ? Number(budgetBase) : total;
  const limits = [
    ['cash_reserve', (Number(cash) || 0) - (Number(params.minCashReserve) || 0) * total],
    ['daily_budget', (Number(params.dailyBuyBudget) || 0) * base - (Number(spentToday) || 0)],
    ['gross_exposure', (Number(params.maxGrossExposure) || 0) * total - (Number(positionsValue) || 0)],
  ];
  let allowed = want;
  let binding = null;
  for (const [name, headroom] of limits) {
    const h = Math.max(headroom, 0);
    if (h < allowed) {
      allowed = h;
      binding = name;
    }
  }
  return { spend: allowed, clamped: allowed < want, binding };
}

/**
 * 当日开新仓计数状态机(换日重置;加仓不计,由调用方只对新开仓调用)。
 * state: { dayKey, symbols: string[] };返回新 state。
 */
export function updateNewPositionState(state, { dayKey, symbol }) {
  const symbols = state?.dayKey === dayKey ? new Set(state.symbols || []) : new Set();
  if (symbol) symbols.add(symbol);
  return { dayKey, symbols: [...symbols] };
}

// ===== 有状态薄层(进程内缓存 + DB 查询,fail-open) =====

// 当日基线缓存与熔断状态;基线告警每日一次,避免新装首日刷屏
let baselineCache = { dayKey: null, value: null };
let dailyLossState = { dayKey: null, tripped: false };
let baselineWarnedDay = null;

async function getDayBaseline(dayKey) {
  if (baselineCache.dayKey === dayKey) return baselineCache.value;
  let value = null;
  try {
    // 与 statsService#computeStats 同口径:美东今日之前的最后一条净值快照
    const { data, error } = await supabase()
      .from('portfolio_snapshots')
      .select('total_value, created_at')
      .lt('created_at', etMidnightUtcIso())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && data) value = Number(data.total_value);
  } catch {
    // 查询失败按基线不可得处理(fail-open)
  }
  baselineCache = { dayKey, value: Number.isFinite(value) && value > 0 ? value : null };
  if (baselineCache.value === null && baselineWarnedDay !== dayKey) {
    baselineWarnedDay = dayKey;
    console.warn('[risk] 当日亏损熔断缺少基线快照(新装首日或快照不可用),本日不生效');
  }
  return baselineCache.value;
}

/**
 * 当日亏损熔断判定(买入路径调用)。基线按日缓存,锁内基本不产生额外查询;
 * 基线不可得时 fail-open 放行(风控层不因数据缺失阻断交易,但会告警)。
 */
export async function evaluateDailyLossHalt(totalValue) {
  if (!(config.dailyLossHaltPercent > 0)) return { halted: false, dayPnlPercent: null };
  const dayKey = etDayKey();
  const baseline = await getDayBaseline(dayKey);
  const dayPnlPercent = computeDayPnlPercent(totalValue, baseline);
  const wasTripped = dailyLossState.dayKey === dayKey && dailyLossState.tripped;
  dailyLossState = updateDailyLossState(dailyLossState, {
    dayKey,
    dayPnlPercent,
    thresholdPercent: config.dailyLossHaltPercent,
  });
  if (dailyLossState.tripped && !wasTripped) {
    console.warn(
      `[risk] 当日亏损 ${dayPnlPercent.toFixed(2)}% 达到熔断阈值 -${config.dailyLossHaltPercent}%,今日停止开新仓`
    );
  }
  return { halted: dailyLossState.tripped, dayPnlPercent };
}

/** 连亏降仓乘数(查最近 N 笔卖出盈亏,与 buildRiskContext.recentSells 同口径);失败 fail-open 返回 1 */
export async function getLossStreakMultiplier() {
  if (!(config.lossStreakCount > 0) || !(config.lossStreakScale < 1)) return 1;
  try {
    const { data, error } = await supabase()
      .from('trades')
      .select('realized_pnl')
      .eq('side', 'sell')
      .not('realized_pnl', 'is', null)
      .order('created_at', { ascending: false })
      .limit(config.lossStreakCount);
    if (error) return 1;
    return lossStreakMultiplier(
      (data || []).map((t) => Number(t.realized_pnl)),
      { count: config.lossStreakCount, scale: config.lossStreakScale }
    );
  } catch {
    return 1;
  }
}

// 当日买入金额缓存(预算钳制用)与当日新开仓集合(014)
let buySpentCache = { dayKey: null, value: null, at: 0 };
let newPositionState = { dayKey: null, symbols: [] };
let newPositionSeededDay = null;

/** 当日(美东)已花费的买入金额合计;查询失败 fail-open 按 0 计并告警 */
export async function getDailyBuySpent() {
  const dayKey = etDayKey();
  if (buySpentCache.dayKey === dayKey && Date.now() - buySpentCache.at < 30_000) {
    return buySpentCache.value;
  }
  let value = 0;
  try {
    const { data, error } = await supabase()
      .from('trades')
      .select('amount')
      .eq('side', 'buy')
      .gte('created_at', etMidnightUtcIso());
    if (error) {
      console.warn(`[risk] 查询当日买入金额失败(预算按已花 0 处理): ${error.message}`);
    } else {
      value = (data || []).reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    }
  } catch (err) {
    console.warn(`[risk] 查询当日买入金额失败(预算按已花 0 处理): ${err.message}`);
  }
  buySpentCache = { dayKey, value, at: Date.now() };
  return value;
}

/** 成交后增量记账(避免 30s 缓存窗口内连续买入时预算失准) */
export function noteBuySpent(amount) {
  const dayKey = etDayKey();
  if (buySpentCache.dayKey === dayKey && buySpentCache.value !== null) {
    buySpentCache.value += Number(amount) || 0;
  }
}

/**
 * 当日已开新仓数。重启后用当日 buy 交易的 distinct symbols 播种——
 * 会把加仓也计入(保守超计),方向安全:宁可少开仓,不可超配额。
 */
export async function getNewPositionsToday() {
  const dayKey = etDayKey();
  if (newPositionState.dayKey !== dayKey) {
    newPositionState = { dayKey, symbols: [] };
    newPositionSeededDay = null;
  }
  if (newPositionSeededDay !== dayKey) {
    newPositionSeededDay = dayKey;
    try {
      const { data, error } = await supabase()
        .from('trades')
        .select('symbol')
        .eq('side', 'buy')
        .gte('created_at', etMidnightUtcIso());
      if (!error) {
        for (const t of data || []) {
          newPositionState = updateNewPositionState(newPositionState, { dayKey, symbol: t.symbol });
        }
      }
    } catch {
      // 播种失败按进程内计数继续(fail-open)
    }
  }
  return newPositionState.symbols.length;
}

/** 开新仓成交后记账(加仓不调用) */
export function noteNewPositionOpened(symbol) {
  newPositionState = updateNewPositionState(newPositionState, { dayKey: etDayKey(), symbol });
}

/** 当前硬风控状态(管理页展示) */
export function getRiskControlState() {
  return {
    dailyLossTripped: dailyLossState.dayKey === etDayKey() && dailyLossState.tripped,
    dailyLossHaltPercent: config.dailyLossHaltPercent,
    maxOpenPositions: config.maxOpenPositions,
    maxSectorFraction: config.maxSectorFraction,
  };
}

/** 当日预算基数:日初组合总值(与亏损熔断同一基线快照),不可得返回 null */
export async function getDailyBudgetBase() {
  return getDayBaseline(etDayKey());
}

/** 管理重置时清进程内状态(快照已清空,基线/熔断状态随之失效) */
export function resetRiskControlState() {
  baselineCache = { dayKey: null, value: null };
  dailyLossState = { dayKey: null, tripped: false };
  baselineWarnedDay = null;
  buySpentCache = { dayKey: null, value: null, at: 0 };
  newPositionState = { dayKey: null, symbols: [] };
  newPositionSeededDay = null;
}
