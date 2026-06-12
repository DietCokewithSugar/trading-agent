// 买入候选池存取(candidate_signals,014):可交易的利好信号不再先到先得即时成交,
// 而是入池等待资金分配器统一打分排序。表缺失(迁移未执行)时整体停用,
// 调用方退回旧的即时交易路径,系统照常可用。
import { supabase } from '../db.js';
import { config } from '../config.js';
import { sanitizeProviderText } from './metrics.js';

/** 可复评的非终态:每轮分配重新打分/重评;其余状态为终态 */
export const ACTIVE_STATUSES = ['pending', 'capital_constrained', 'conflict_hold', 'macro_filtered'];

let tableMissing = false;

function isMissingTable(error) {
  return (
    error?.code === 'PGRST205' ||
    (/candidate_signals/.test(error?.message || '') &&
      /not find|does not exist|schema cache/i.test(error?.message || ''))
  );
}

function warnMissingOnce() {
  if (tableMissing) return;
  tableMissing = true;
  console.warn('[pool] candidate_signals 表不可用,候选池停用,买入退回即时交易路径(请执行 014 迁移)');
}

/** 候选池是否可用 */
export function isPoolAvailable() {
  return config.enableMacro && !tableMissing;
}

// 016 迁移新增的可选列:旧库缺列时逐列剥离重试(入池绝不能因可选列失败——
// 否则 016 未迁移的库会把信号踢回即时交易路径,行为静默回退)
const OPTIONAL_CANDIDATE_COLUMNS = ['entry_price'];
const missingCandidateColumns = new Set();

/** 信号入池。失败返回 null,由调用方退回即时交易路径,信号不丢 */
export async function enqueueCandidate(candidate) {
  if (!isPoolAvailable()) return null;
  const row = {
    ...candidate,
    status: candidate.status || 'pending',
    status_reason: candidate.status_reason ? sanitizeProviderText(candidate.status_reason) : null,
    expires_at: new Date(Date.now() + config.candidateMaxAgeHours * 3600_000).toISOString(),
  };
  for (const col of missingCandidateColumns) delete row[col];
  let { data, error } = await supabase().from('candidate_signals').insert(row).select().single();
  while (error && /column|schema/i.test(error.message)) {
    const col = OPTIONAL_CANDIDATE_COLUMNS.find((c) => c in row && error.message.includes(c));
    if (!col) break;
    missingCandidateColumns.add(col);
    console.warn(`[pool] candidate_signals 缺少 ${col} 列,已降级不记录(请执行 016 迁移)`);
    delete row[col];
    ({ data, error } = await supabase().from('candidate_signals').insert(row).select().single());
  }
  if (error) {
    if (isMissingTable(error)) warnMissingOnce();
    else console.warn(`[pool] ${candidate.symbol} 入池失败,退回即时交易: ${error.message}`);
    return null;
  }
  console.log(
    `[pool] ${data.symbol} 利好候选入池 #${data.id}(档位${data.tier} 基础分${data.base_score}${data.status !== 'pending' ? ` 状态=${data.status}` : ''})`
  );
  return data;
}

/** 全部活跃候选(待分配/资金受限/冲突搁置/宏观过滤),按入池时间升序;不可用返回 null */
export async function listActiveCandidates() {
  if (!isPoolAvailable()) return null;
  const { data, error } = await supabase()
    .from('candidate_signals')
    .select('*')
    .in('status', ACTIVE_STATUSES)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) {
    if (isMissingTable(error)) warnMissingOnce();
    else console.warn(`[pool] 读取候选池失败: ${error.message}`);
    return null;
  }
  return data || [];
}

/**
 * 更新候选状态/分数(status_reason 出现在公共读表,统一脱敏)。
 * expectedStatus(乐观并发):仅当行的当前状态仍为该值时才更新,防止分配轮用内存快照
 * 覆盖并发写入(典型:利空信号在分配轮进行中触发的 conflict_hold)。
 * expectedUpdatedAt:状态值做版本号有 ABA 洞——旧 conflict_hold 出窗复活的同一时刻,
 * 新利空把行写回 conflict_hold,状态值不变、按状态比对会误判"无并发修改"并覆盖回 pending;
 * 加上行的 updated_at(每次写入都刷新)做严格版本比对后,任何并发写都会让本次更新落空。
 * 失败/未命中返回 false,成功返回本次写入的 updated_at(truthy,调用方据此刷新内存快照)。
 */
export async function updateCandidate(id, fields, { expectedStatus, expectedUpdatedAt } = {}) {
  if (!isPoolAvailable()) return false;
  const payload = {
    ...fields,
    ...(fields.status_reason ? { status_reason: sanitizeProviderText(String(fields.status_reason).slice(0, 200)) } : {}),
    updated_at: new Date().toISOString(),
    last_evaluated_at: new Date().toISOString(),
  };
  let query = supabase().from('candidate_signals').update(payload).eq('id', id);
  if (expectedStatus) query = query.eq('status', expectedStatus);
  if (expectedUpdatedAt) query = query.eq('updated_at', expectedUpdatedAt);
  const { data, error } = await query.select('id');
  if (error) {
    console.warn(`[pool] 更新候选 #${id} 失败: ${error.message}`);
    return false;
  }
  if ((expectedStatus || expectedUpdatedAt) && !(data || []).length) {
    console.log(`[pool] 候选 #${id} 已被并发修改,跳过本次更新`);
    return false;
  }
  return payload.updated_at;
}

/** 执行前重读候选当前状态:关闭"读快照 → LLM 长调用 → 执行"窗口内的冲突搁置竞态。
 *  读取失败返回 null,调用方按"不执行买入"处理(宁可错过,不可误买) */
export async function getCandidateStatus(id) {
  if (!isPoolAvailable()) return null;
  const { data, error } = await supabase()
    .from('candidate_signals')
    .select('status')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.warn(`[pool] 读取候选 #${id} 状态失败: ${error.message}`);
    return null;
  }
  return data?.status || null;
}

/** 过期清理:超过有效期的活跃候选置为 expired,返回清理数 */
export async function expireStale(now = new Date()) {
  if (!isPoolAvailable()) return 0;
  const { data, error } = await supabase()
    .from('candidate_signals')
    .update({
      status: 'expired',
      status_reason: `超过有效期 ${config.candidateMaxAgeHours} 小时`,
      updated_at: now.toISOString(),
    })
    .in('status', ACTIVE_STATUSES)
    .lt('expires_at', now.toISOString())
    .select('id');
  if (error) {
    if (isMissingTable(error)) warnMissingOnce();
    else console.warn(`[pool] 过期清理失败: ${error.message}`);
    return 0;
  }
  if (data?.length) console.log(`[pool] ${data.length} 个候选超龄过期`);
  return data?.length || 0;
}

/** 同票买入候选冲突搁置(收到反向卖出信号时调用;fail-open,失败仅告警) */
export async function holdBuyCandidates(symbol, reason) {
  if (!isPoolAvailable()) return;
  const { data, error } = await supabase()
    .from('candidate_signals')
    .update({
      status: 'conflict_hold',
      status_reason: sanitizeProviderText(String(reason || '').slice(0, 200)),
      updated_at: new Date().toISOString(),
    })
    .eq('symbol', symbol)
    .in('status', ACTIVE_STATUSES)
    .select('id');
  if (error) {
    console.warn(`[pool] ${symbol} 冲突搁置失败: ${error.message}`);
    return;
  }
  if (data?.length) console.log(`[pool] ${symbol} ${data.length} 个买入候选因反向信号冲突搁置`);
}

/** macro_shock 时取消低分候选(高分候选留池待冲击解除后复评) */
export async function cancelLowScore(threshold, reason) {
  if (!isPoolAvailable()) return;
  const { data, error } = await supabase()
    .from('candidate_signals')
    .update({
      status: 'cancelled',
      status_reason: sanitizeProviderText(String(reason || '').slice(0, 200)),
      updated_at: new Date().toISOString(),
    })
    .in('status', ACTIVE_STATUSES)
    .lt('current_score', threshold)
    .select('id');
  if (error) {
    console.warn(`[pool] 取消低分候选失败: ${error.message}`);
    return;
  }
  if (data?.length) console.log(`[pool] 宏观冲击:${data.length} 个低分候选已取消`);
}

/** 同票成交后取消其余兄弟候选(避免下一轮重复占用分配名额再被冷却拒绝) */
export async function cancelSiblings(symbol, keepId, reason) {
  if (!isPoolAvailable()) return;
  const { error } = await supabase()
    .from('candidate_signals')
    .update({
      status: 'cancelled',
      status_reason: sanitizeProviderText(String(reason || '').slice(0, 200)),
      updated_at: new Date().toISOString(),
    })
    .eq('symbol', symbol)
    .neq('id', keepId)
    .in('status', ACTIVE_STATUSES);
  if (error) console.warn(`[pool] ${symbol} 取消兄弟候选失败: ${error.message}`);
}

/** 候选池状态分布(宏观页/SSE 用);不可用返回 null */
export async function countByStatus() {
  if (!isPoolAvailable()) return null;
  const { data, error } = await supabase()
    .from('candidate_signals')
    .select('status')
    .in('status', ACTIVE_STATUSES);
  if (error) {
    if (isMissingTable(error)) warnMissingOnce();
    return null;
  }
  const counts = {};
  for (const row of data || []) counts[row.status] = (counts[row.status] || 0) + 1;
  return counts;
}

/** 候选池预览(宏观页):活跃候选按当前分倒序;不可用返回 null */
export async function listPoolPreview(limit = 10) {
  if (!isPoolAvailable()) return null;
  const { data, error } = await supabase()
    .from('candidate_signals')
    .select('id, symbol, tier, sentiment, confidence, final_confidence, sector, current_score, base_score, status, status_reason, macro_regime, created_at, expires_at')
    .in('status', ACTIVE_STATUSES)
    .order('current_score', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) {
    if (isMissingTable(error)) warnMissingOnce();
    return null;
  }
  return data || [];
}
