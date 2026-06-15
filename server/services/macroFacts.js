// 宏观事实层(020):把「宏观事件」而非「新闻文章」作为风险计量的唯一单位。
// 一次 CPI 发布就是一个事件(event_key=CPI_2026-05),不管被几篇新闻报道只贡献一次风险分。
//
// 本模块只放纯函数(键派生 / 日历类型识别 / 意外幅度 → 方向与权重)与 macro_facts 的
// 原子 CRUD,不 import 任何其他 service —— 避免 macroRegime↔macroService 的既有循环依赖,
// 编排(LLM 判重、日历 upsert)分别留在 macroService.js / macroCalendar.js。
import { supabase } from '../db.js';

// 周期性经济数据:同一指标每期只发布一次,可按「类型+美东年月」确定性去重
export const PERIODIC_EVENT_TYPES = new Set(['CPI', 'PPI', 'PCE', 'NFP', 'GDP', 'FOMC']);

// 日历独建事实的默认档位(无新闻解释时):全市场级数据给 1 档,其余 2 档
const CALENDAR_FACT_TIER = { CPI: 1, FOMC: 1, NFP: 1, PCE: 2, PPI: 2, GDP: 2 };

// 各指标「显著超预期」的相对幅度量纲(surpriseWeight 归一用);缺省 0.2
const SURPRISE_SCALE = { CPI: 0.05, PPI: 0.08, PCE: 0.05, NFP: 0.3, GDP: 0.4, FOMC: 0.05, default: 0.2 };

const ET_DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

/** 给定时刻的美东日历日 "YYYY-MM-DD"(事件键与"同日"判定统一以美东为准) */
export function etDay(occurredAt = new Date()) {
  return ET_DAY_FMT.format(new Date(occurredAt));
}

/**
 * 派生确定性事件键(纯函数):周期性数据返回「类型_美东年月」(CPI_2026-05),
 * 非周期事件(地缘/能源/关税/财政/收益率/其他)返回 null —— 交由 LLM 判重 + mintEventKey。
 */
export function deriveEventKey(eventType, occurredAt = new Date()) {
  if (!PERIODIC_EVENT_TYPES.has(eventType)) return null;
  return `${eventType}_${etDay(occurredAt).slice(0, 7)}`;
}

/**
 * 非周期事件的唯一键(纯函数):类型_美东日_新闻ID。
 * 用新闻 ID 作后缀同时保证唯一与可追溯;无 ID 时退回时间戳。
 */
export function mintEventKey(eventType, occurredAt = new Date(), newsId = null) {
  const suffix = newsId ?? Date.now().toString(36);
  return `${eventType}_${etDay(occurredAt)}_${suffix}`;
}

/**
 * 把 FMP 经济日历的事件名映射到我们的 event_type(纯函数);
 * 只识别可确定性去重的周期性数据,其余返回 null(不为任意日历行建事实)。
 */
export function classifyCalendarEventType(eventName) {
  const name = String(eventName || '').toLowerCase();
  if (/\bcore pce\b|pce price/.test(name)) return 'PCE';
  if (/\bcpi\b|consumer price/.test(name)) return 'CPI';
  if (/\bppi\b|producer price/.test(name)) return 'PPI';
  if (/nonfarm|non-farm|payroll/.test(name)) return 'NFP';
  if (/\bgdp\b/.test(name)) return 'GDP';
  if (/fomc|fed (funds )?(interest )?rate|federal funds|interest rate decision/.test(name)) return 'FOMC';
  return null;
}

/**
 * 由意外幅度确定性推出方向(纯函数,数据事实层,不依赖新闻解释):
 * 通胀/政策类(CPI/PPI/PCE/FOMC)高于预期 → 鹰派、利空风险资产(降息无望);低于预期反之。
 * 增长类(NFP/GDP)好坏含义随 regime 而异(强数据=增长 vs 担心 Fed 更鹰),
 * 确定性层只标增长方向、不擅自定 risk 方向,留给新闻解释。
 * 返回 { macro_direction, rates_signal, inflation_signal, growth_signal, surprise_direction }。
 */
export function inflationSurpriseDirection(eventType, surprise) {
  const neutral = {
    macro_direction: 'neutral',
    rates_signal: 'neutral',
    inflation_signal: 'neutral',
    growth_signal: 'neutral',
    surprise_direction: 'unknown',
  };
  const s = Number(surprise);
  if (!Number.isFinite(s)) return neutral;
  const EPS = 1e-9;
  if (eventType === 'CPI' || eventType === 'PPI' || eventType === 'PCE' || eventType === 'FOMC') {
    const inflation = eventType === 'FOMC' ? 'neutral' : s > EPS ? 'up' : 'down';
    if (s > EPS) {
      return { macro_direction: 'risk_off', rates_signal: 'hawkish', inflation_signal: inflation, growth_signal: 'neutral', surprise_direction: 'negative' };
    }
    if (s < -EPS) {
      return { macro_direction: 'risk_on', rates_signal: 'dovish', inflation_signal: inflation, growth_signal: 'neutral', surprise_direction: 'positive' };
    }
    return { ...neutral, surprise_direction: 'inline' };
  }
  if (eventType === 'NFP' || eventType === 'GDP') {
    if (s > EPS) return { ...neutral, growth_signal: 'up', surprise_direction: 'positive' };
    if (s < -EPS) return { ...neutral, growth_signal: 'down', surprise_direction: 'negative' };
    return { ...neutral, surprise_direction: 'inline' };
  }
  return neutral;
}

/**
 * 意外幅度 → eventWeight 乘数(纯函数,clamp [0.6, 1.5]):
 * 超预期越多权重越大,符合预期(≈0)略降到 ~0.85(已被市场 price-in 的数据冲击更小);
 * 仅有前值(basis='previous',无市场预期)时意外信号减半。缺失 surprise 返回 1(中性)。
 */
export function surpriseWeight(eventType, surprise, basis) {
  const s = Number(surprise);
  if (!Number.isFinite(s)) return 1;
  const scale = SURPRISE_SCALE[eventType] ?? SURPRISE_SCALE.default;
  const mag = Math.min(Math.abs(s) / scale, 1);
  let mult = 0.85 + 0.65 * mag; // [0.85, 1.5]
  if (basis === 'previous') mult = 1 + (mult - 1) * 0.5; // 缺预期基准,意外减半
  return Number(Math.min(Math.max(mult, 0.6), 1.5).toFixed(3));
}

/** 日历独建事实的默认档位 */
export function calendarFactTier(eventType) {
  return CALENDAR_FACT_TIER[eventType] ?? 3;
}

// ── macro_facts 原子 CRUD(迁移容忍:表缺失一次告警后停用,上层回退 macro_events 路径)──

const state = { tableMissing: false };

function isMissingTable(error) {
  return /does not exist|not find|schema cache/i.test(error?.message || '');
}

function isUniqueViolation(error) {
  return /duplicate key|unique constraint|already exists/i.test(error?.message || '');
}

/** macro_facts 表是否缺失(未执行 020 迁移);上层据此回退 macro_events 路径 */
export function isFactsTableMissing() {
  return state.tableMissing;
}

/** 管理重置后复位进程内状态(表本身由 reset 流程清空) */
export function resetFactsState() {
  state.tableMissing = false;
}

/** 近 N 小时的宏观事实(regime 聚合 / sectorMultiplier / api 用);表缺失返回 null */
export async function listRecentMacroFacts(hours, limit = 100) {
  if (state.tableMissing) return null;
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data, error } = await supabase()
    .from('macro_facts')
    .select('*')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingTable(error)) {
      state.tableMissing = true;
      console.warn('[macro] macro_facts 表缺失(请执行 020 迁移),回退 macro_events 聚合路径');
      return null;
    }
    throw new Error(`读取宏观事实失败: ${error.message}`);
  }
  return data || [];
}

/** 按 event_key 取事实;不存在返回 null;表缺失返回 undefined(上层据此回退) */
export async function findFactByKey(eventKey) {
  if (state.tableMissing) return undefined;
  const { data, error } = await supabase()
    .from('macro_facts')
    .select('*')
    .eq('event_key', eventKey)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) {
      state.tableMissing = true;
      console.warn('[macro] macro_facts 表缺失(请执行 020 迁移),回退 macro_events 聚合路径');
      return undefined;
    }
    throw new Error(`查询宏观事实失败: ${error.message}`);
  }
  return data || null;
}

/**
 * 插入新事实;event_key 唯一冲突(日历与新闻并发建同一事件)时返回已有行供调用方改走更新,
 * 表缺失返回 undefined。
 */
export async function insertFact(row) {
  if (state.tableMissing) return undefined;
  const { data, error } = await supabase().from('macro_facts').insert(row).select().single();
  if (!error) return data;
  if (isMissingTable(error)) {
    state.tableMissing = true;
    console.warn('[macro] macro_facts 表缺失(请执行 020 迁移),回退 macro_events 聚合路径');
    return undefined;
  }
  if (isUniqueViolation(error)) {
    // 并发建同键:回读已有行,由调用方合并更新
    return (await findFactByKey(row.event_key)) || null;
  }
  throw new Error(`宏观事实入库失败: ${error.message}`);
}

/** 局部更新事实;表缺失返回 undefined */
export async function updateFact(id, patch) {
  if (state.tableMissing) return undefined;
  const { data, error } = await supabase()
    .from('macro_facts')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) {
    if (isMissingTable(error)) {
      state.tableMissing = true;
      return undefined;
    }
    throw new Error(`更新宏观事实失败: ${error.message}`);
  }
  return data;
}
