import { supabase } from '../db.js';

/**
 * cycle_runs 落库与查询(012 迁移):每轮 runCycle 的运行指标持久化。
 * 纯观测层,fail-open:表不可用(012 未执行)只告警一次后停用,
 * 任何写入/查询失败都不允许影响交易主链路。
 */

let tableMissing = false;

function isMissingTable(error) {
  return (
    error?.code === 'PGRST205' ||
    (/cycle_runs/.test(error?.message || '') &&
      /not find|does not exist|schema cache/i.test(error?.message || ''))
  );
}

function warnMissingOnce() {
  if (tableMissing) return;
  tableMissing = true;
  console.warn('[metrics] cycle_runs 表不可用,运行指标不落库(请执行 012 迁移)');
}

/** cycle_runs 是否可用(管理页据此提示执行迁移) */
export function isCycleRunsAvailable() {
  return !tableMissing;
}

/** 合并多轮的 reject_reasons jsonb({ 原因: 次数 }),容忍 null/非对象行 */
export function aggregateRejectReasons(runs) {
  const merged = {};
  for (const run of runs || []) {
    const reasons = run?.reject_reasons;
    if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons)) continue;
    for (const [reason, count] of Object.entries(reasons)) {
      const n = Number(count);
      if (!Number.isFinite(n) || n <= 0) continue;
      merged[reason] = (merged[reason] || 0) + n;
    }
  }
  return merged;
}

// 014/020 新增的可选计数列:旧库(迁移未执行)缺列时逐个剥离重试
const OPTIONAL_RUN_COLUMNS = ['pooled', 'macro_events', 'refreshed'];

/** 写入一轮运行指标,绝不抛错 */
export async function saveCycleRun(row) {
  if (tableMissing) return;
  try {
    const payload = { ...row };
    let { error } = await supabase().from('cycle_runs').insert(payload);
    while (error) {
      const col = OPTIONAL_RUN_COLUMNS.find((c) => c in payload && error.message.includes(c));
      if (!col) break;
      delete payload[col];
      ({ error } = await supabase().from('cycle_runs').insert(payload));
    }
    if (error) {
      if (isMissingTable(error)) warnMissingOnce();
      else console.warn(`[metrics] 运行指标落库失败: ${error.message}`);
    }
  } catch (err) {
    console.warn(`[metrics] 运行指标落库失败: ${err.message}`);
  }
}

/** 最近 N 轮运行(管理接口用),表不可用返回空数组 */
export async function listRecentRuns(limit = 20) {
  if (tableMissing) return [];
  try {
    const { data, error } = await supabase()
      .from('cycle_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) {
      if (isMissingTable(error)) warnMissingOnce();
      else console.warn(`[metrics] 读取运行记录失败: ${error.message}`);
      return [];
    }
    return data || [];
  } catch (err) {
    console.warn(`[metrics] 读取运行记录失败: ${err.message}`);
    return [];
  }
}
