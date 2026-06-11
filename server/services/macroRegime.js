// 宏观环境(regime)聚合:近期 macro_events 时间衰减加权 → 连续风险偏好分 → 四态 regime。
// LLM 只做单事件分类,聚合完全由本模块的纯函数完成(确定性、可单测);
// 状态持久化在 macro_state 单行表,重启后延续。表缺失时恒为 neutral(fail-open 回 013 行为)。
import { supabase } from '../db.js';
import { config } from '../config.js';
import { listRecentMacroEvents } from './macroService.js';
import { broadcast } from './bus.js';

/** 事件档位权重:全市场级事件主导,情绪级只起微调作用 */
const TIER_WEIGHTS = { 1: 1.0, 2: 0.6, 3: 0.3 };
/** 子标签(利率/通胀/增长)聚合的判定阈值 */
const SUB_SIGNAL_THRESHOLD = 0.15;

function eventWeight(event, nowTs, halfLifeHours) {
  const tierWeight = TIER_WEIGHTS[event.market_impact_tier] ?? 0.3;
  const conf = Number.isFinite(Number(event.confidence)) ? Number(event.confidence) : 0.5;
  const ageHours = Math.max((nowTs - new Date(event.created_at).getTime()) / 3600_000, 0);
  return tierWeight * conf * Math.exp(-ageHours / halfLifeHours);
}

/** 带平滑的加权方向分:单一弱事件不足以把状态推到极端 */
function weightedScore(pairs, smoothing = 1) {
  let raw = 0;
  let total = 0;
  for (const { weight, direction } of pairs) {
    raw += weight * direction;
    total += weight;
  }
  if (total === 0) return 0;
  return Math.min(Math.max(raw / (total + smoothing), -1), 1);
}

function aggregateSubSignal(events, nowTs, halfLifeHours, field, positive, negative) {
  const pairs = events
    .filter((e) => e[field] === positive || e[field] === negative)
    .map((e) => ({
      weight: eventWeight(e, nowTs, halfLifeHours),
      direction: e[field] === positive ? 1 : -1,
    }));
  const score = weightedScore(pairs, 0.5);
  if (score > SUB_SIGNAL_THRESHOLD) return positive;
  if (score < -SUB_SIGNAL_THRESHOLD) return negative;
  return 'neutral';
}

/**
 * 由近期宏观事件聚合当前 regime(纯函数)。
 * events: macro_events 行;prev: 上一状态(滞回与 shock 延续用);cfg 见 defaults。
 * 返回 { regime, riskScore, rates, inflation, growth, shockUntil }。
 */
export function aggregateRegime({ events = [], now = new Date(), prev = null, cfg = {} } = {}) {
  const {
    validityHours = 72,
    shockHours = 6,
    halfLifeHours = 24,
    enterThreshold = 0.3,
    exitThreshold = 0.2,
    shockMinConfidence = 0.75,
  } = cfg;
  const nowTs = now instanceof Date ? now.getTime() : Number(now);
  const valid = (Array.isArray(events) ? events : []).filter((e) => {
    const ts = new Date(e?.created_at || 0).getTime();
    return Number.isFinite(ts) && nowTs - ts <= validityHours * 3600_000 && ts <= nowTs;
  });

  // 硬规则:一档高置信 risk_off 事件 → macro_shock 锁定期(取最近一次触发的到期时间)
  let shockUntil = prev?.shockUntil && new Date(prev.shockUntil).getTime() > nowTs ? prev.shockUntil : null;
  for (const e of valid) {
    if (
      e.market_impact_tier === 1 &&
      e.macro_direction === 'risk_off' &&
      Number(e.confidence) >= shockMinConfidence
    ) {
      const until = new Date(new Date(e.created_at).getTime() + shockHours * 3600_000);
      if (until.getTime() > nowTs && (!shockUntil || until.getTime() > new Date(shockUntil).getTime())) {
        shockUntil = until.toISOString();
      }
    }
  }

  const riskScore = Number(
    weightedScore(
      valid
        .filter((e) => e.macro_direction === 'risk_on' || e.macro_direction === 'risk_off')
        .map((e) => ({
          weight: eventWeight(e, nowTs, halfLifeHours),
          direction: e.macro_direction === 'risk_on' ? 1 : -1,
        }))
    ).toFixed(3)
  );

  // 滞回:进入新状态要求更强的分数,退出沿用较松的阈值,防止边界附近来回切换
  let regime;
  const prevRegime = prev?.regime === 'macro_shock' ? 'risk_off' : prev?.regime || 'neutral';
  if (shockUntil) {
    regime = 'macro_shock';
  } else if (riskScore >= (prevRegime === 'risk_on' ? exitThreshold : enterThreshold)) {
    regime = 'risk_on';
  } else if (riskScore <= -(prevRegime === 'risk_off' ? exitThreshold : enterThreshold)) {
    regime = 'risk_off';
  } else {
    regime = 'neutral';
  }

  return {
    regime,
    riskScore,
    rates: aggregateSubSignal(valid, nowTs, halfLifeHours, 'rates_signal', 'hawkish', 'dovish'),
    inflation: aggregateSubSignal(valid, nowTs, halfLifeHours, 'inflation_signal', 'up', 'down'),
    growth: aggregateSubSignal(valid, nowTs, halfLifeHours, 'growth_signal', 'up', 'down'),
    shockUntil,
  };
}

/**
 * 行业宏观乘数(纯函数):近期事件的 affected_sectors 命中该行业时,
 * 利好放大/利空压缩买入金额,clamp [0.6, 1.2];无命中返回 1。
 */
export function sectorMultiplier(sector, events = [], now = new Date(), cfg = {}) {
  if (!sector) return 1;
  const { validityHours = 72, halfLifeHours = 24 } = cfg;
  const nowTs = now instanceof Date ? now.getTime() : Number(now);
  const pairs = [];
  for (const e of Array.isArray(events) ? events : []) {
    const ts = new Date(e?.created_at || 0).getTime();
    if (!Number.isFinite(ts) || nowTs - ts > validityHours * 3600_000) continue;
    const sectors = Array.isArray(e.affected_sectors) ? e.affected_sectors : [];
    const hit = sectors.find((s) => s?.sector === sector);
    if (!hit) continue;
    pairs.push({
      weight: eventWeight(e, nowTs, halfLifeHours),
      direction: hit.direction === 'bullish' ? 1 : -1,
    });
  }
  if (!pairs.length) return 1;
  const score = weightedScore(pairs, 0.5);
  // 利好最高 ×1.2,利空最低 ×0.6(利空压缩力度大于利好放大,保守不对称)
  const multiplier = score >= 0 ? 1 + 0.2 * score : 1 + 0.4 * score;
  return Number(Math.min(Math.max(multiplier, 0.6), 1.2).toFixed(3));
}

// ── 持久化薄层(macro_state 单行表 + 进程内缓存)──

const REGIME_DEFAULTS = {
  regime: 'neutral',
  risk_score: 0,
  rates_signal: 'neutral',
  inflation_signal: 'neutral',
  growth_signal: 'neutral',
  shock_until: null,
  updated_at: null,
};

const state = {
  cached: { ...REGIME_DEFAULTS },
  loaded: false,
  tableMissing: false,
  recomputing: false,
};

function isMissingTable(error) {
  return /does not exist|not find|schema cache/i.test(error?.message || '');
}

/** 当前 regime(同步,读进程内缓存;未加载/表缺失时为 neutral) */
export function getRegime() {
  return state.cached;
}

/** 指定 regime 的组合参数集(未知值按 neutral 兜底) */
export function getRegimeParams(regime) {
  return config.macroRegimeParams[regime] || config.macroRegimeParams.neutral;
}

/** 启动时从 macro_state 加载上次状态(重启延续);表缺失保持 neutral */
export async function initMacroRegime() {
  if (!config.enableMacro) return;
  try {
    const { data, error } = await supabase().from('macro_state').select('*').eq('id', 1).single();
    if (error) {
      if (isMissingTable(error)) {
        state.tableMissing = true;
        console.warn('[macro] macro_state 表缺失(请执行 014 迁移),宏观环境恒为 neutral');
      } else {
        console.warn(`[macro] 加载宏观状态失败: ${error.message}`);
      }
      return;
    }
    if (data) state.cached = { ...REGIME_DEFAULTS, ...data };
    state.loaded = true;
    console.log(`[macro] 宏观状态已加载: ${state.cached.regime} (risk_score=${state.cached.risk_score})`);
  } catch (err) {
    console.warn(`[macro] 加载宏观状态失败: ${err.message}`);
  }
}

const REGIME_LABELS = {
  risk_on: '风险偏好',
  neutral: '中性',
  risk_off: '避险',
  macro_shock: '宏观冲击',
};

/**
 * 重算 regime(新宏观事件落库后 / 调度器周期衰减)并持久化与广播变化。
 * 任何失败只告警——宏观层永不打断交易主链路。
 */
export async function recomputeRegime(trigger = 'decay') {
  if (!config.enableMacro || state.tableMissing || state.recomputing) return state.cached;
  state.recomputing = true;
  try {
    const events = await listRecentMacroEvents(config.macroEventValidityHours);
    if (events === null) return state.cached; // macro_events 表缺失,macroService 已告警

    const prev = {
      regime: state.cached.regime,
      shockUntil: state.cached.shock_until,
    };
    const next = aggregateRegime({
      events,
      now: new Date(),
      prev,
      cfg: {
        validityHours: config.macroEventValidityHours,
        shockHours: config.macroShockHours,
      },
    });

    const changed =
      next.regime !== state.cached.regime ||
      Math.abs(next.riskScore - Number(state.cached.risk_score)) >= 0.05 ||
      next.rates !== state.cached.rates_signal ||
      next.inflation !== state.cached.inflation_signal ||
      next.growth !== state.cached.growth_signal;
    const regimeSwitched = next.regime !== state.cached.regime;

    const row = {
      regime: next.regime,
      risk_score: next.riskScore,
      rates_signal: next.rates,
      inflation_signal: next.inflation,
      growth_signal: next.growth,
      shock_until: next.shockUntil,
      updated_at: new Date().toISOString(),
    };
    if (changed) {
      const { error } = await supabase().from('macro_state').update(row).eq('id', 1);
      if (error) {
        if (isMissingTable(error)) {
          state.tableMissing = true;
          console.warn('[macro] macro_state 表缺失(请执行 014 迁移),宏观环境恒为 neutral');
          return state.cached;
        }
        console.warn(`[macro] 持久化宏观状态失败: ${error.message}`);
      }
    }
    state.cached = { ...state.cached, ...row };
    state.loaded = true;

    if (regimeSwitched) {
      console.log(
        `[macro] 宏观环境切换 → ${REGIME_LABELS[next.regime]}(risk_score=${next.riskScore},触发=${trigger})`
      );
      broadcast('macro', {
        regime: next.regime,
        risk_score: next.riskScore,
        rates_signal: next.rates,
        inflation_signal: next.inflation,
        growth_signal: next.growth,
        shock_until: next.shockUntil,
      });
    }
    return state.cached;
  } catch (err) {
    console.warn(`[macro] 重算宏观环境失败: ${err.message}`);
    return state.cached;
  } finally {
    state.recomputing = false;
  }
}

/** 管理重置后复位进程内缓存(数据库行已由 reset 流程复位) */
export function resetRegimeState() {
  state.cached = { ...REGIME_DEFAULTS };
}
