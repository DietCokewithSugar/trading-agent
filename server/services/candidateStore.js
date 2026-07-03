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

// 016/022 迁移新增的可选列:旧库缺列时逐列剥离重试(入池绝不能因可选列失败——
// 否则 016 未迁移的库会把信号踢回即时交易路径,行为静默回退)
const OPTIONAL_CANDIDATE_COLUMNS = ['entry_price', 'merged_events', 'last_signal_at'];
const missingCandidateColumns = new Set();

/**
 * 纯函数:同票候选合并决策(022)。同票已有活跃候选时,新事件不再插行而是合并:
 * 新信号更强(base_score 严格更高)时刷新信号字段让候选代表最强事件;
 * 无论强弱,事件计数 +1、时效锚点/过期时钟按最新信号续命(与 020 持有时钟
 * "不同利好续命"同语义,上游事件级去重已保证合并进来的是真正的新事件)。
 * 永不返回 status/status_reason/entry_price/created_at/macro_regime——
 * 冲突搁置等状态保持,入池排队成本锚点与评估层分桶口径不变。
 */
export function mergeCandidateFields(existing, incoming, { now = new Date(), maxAgeHours = 24 } = {}) {
  const stronger = Number(incoming.base_score) > Number(existing.base_score || 0);
  return {
    ...(stronger
      ? {
          news_id: incoming.news_id ?? null,
          analysis_id: incoming.analysis_id ?? null,
          event_id: incoming.event_id ?? null,
          tier: incoming.tier ?? null,
          confidence: incoming.confidence ?? null,
          final_confidence: incoming.final_confidence ?? null,
          source_score: incoming.source_score ?? null,
          sector: incoming.sector ?? null,
          base_score: incoming.base_score,
          // 下一分配轮会带衰减/宏观乘数重刷,这里先取新基础分保证排序不落后
          current_score: incoming.base_score,
        }
      : {}),
    merged_events: (Number(existing.merged_events) || 1) + 1,
    last_signal_at: now.toISOString(),
    expires_at: new Date(now.getTime() + maxAgeHours * 3600_000).toISOString(),
  };
}

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
    // 撞同票活跃唯一索引(022):说明同票已有活跃候选(典型:findActiveCandidate
    // 查询失败 fail-open 走了插入)。重查归并返回;重查也失败时返回存根——
    // 唯一冲突本身已证明同票在池,绝不能返回 null 让调用方跌回即时 LLM 交易路径同票双开
    if (error.code === '23505' || /idx_candidate_signals_active_symbol_unique/.test(error.message || '')) {
      console.log(`[pool] ${candidate.symbol} 并发入池撞唯一约束,归并到已有候选`);
      const existing = await findActiveCandidate(candidate.symbol);
      return existing || { id: null, symbol: candidate.symbol };
    }
    if (isMissingTable(error)) warnMissingOnce();
    else console.warn(`[pool] ${candidate.symbol} 入池失败,退回即时交易: ${error.message}`);
    return null;
  }
  console.log(
    `[pool] ${data.symbol} 利好候选入池 #${data.id}(档位${data.tier} 基础分${data.base_score}${data.status !== 'pending' ? ` 状态=${data.status}` : ''})`
  );
  return data;
}

/**
 * 同票活跃候选查询(022 入池合并用):至多一行(唯一索引约束),取最早入池的。
 * 查询失败 warn 后返回 null——调用方按无同票处理继续插入(fail-open),
 * 真有同票时由唯一索引兜底转归并,不会插出重复行。
 */
export async function findActiveCandidate(symbol) {
  if (!isPoolAvailable()) return null;
  const { data, error } = await supabase()
    .from('candidate_signals')
    .select('*')
    .eq('symbol', symbol)
    .in('status', ACTIVE_STATUSES)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) {
    if (isMissingTable(error)) warnMissingOnce();
    else console.warn(`[pool] ${symbol} 查询同票活跃候选失败: ${error.message}`);
    return null;
  }
  return data?.[0] || null;
}

/**
 * 同票候选合并写入(022):带 expectedStatus + expectedUpdatedAt 乐观并发
 *(与分配器同款版本比对);落空 = 其它写者赢(典型:新利空触发的 holdBuyCandidates、
 * 分配轮刷分/成交)→ 返回 null,调用方 fail-closed 跳过不插重复行。
 * 022 未迁移缺列时剥离重试(退化为只刷信号字段+续命,共振计数停用)。
 */
export async function mergeIntoCandidate(existing, incoming) {
  if (!isPoolAvailable()) return null;
  const fields = mergeCandidateFields(existing, incoming, {
    maxAgeHours: config.candidateMaxAgeHours,
  });
  const stronger = 'base_score' in fields;
  for (const col of missingCandidateColumns) delete fields[col];

  // 不复用 updateCandidate:它把"缺列错误"和"并发落空"都折叠成 false,
  // 这里必须区分——缺列要剥离重试,并发落空绝不能误标缺列(会永久停用共振计数)
  const write = async (payload) => {
    return supabase()
      .from('candidate_signals')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .eq('status', existing.status)
      .eq('updated_at', existing.updated_at)
      .select('id, updated_at');
  };
  let { data, error } = await write(fields);
  while (error && /column|schema/i.test(error.message)) {
    const col = OPTIONAL_CANDIDATE_COLUMNS.find((c) => c in fields && error.message.includes(c));
    if (!col) break;
    missingCandidateColumns.add(col);
    console.warn(`[pool] candidate_signals 缺少 ${col} 列,合并降级(请执行 022 迁移)`);
    delete fields[col];
    if (!Object.keys(fields).length) return null;
    ({ data, error } = await write(fields));
  }
  if (error) {
    if (isMissingTable(error)) warnMissingOnce();
    else console.warn(`[pool] ${existing.symbol} 候选 #${existing.id} 合并写入失败: ${error.message}`);
    return null;
  }
  if (!data?.length) {
    console.log(`[pool] ${existing.symbol} 候选 #${existing.id} 合并时被并发修改,跳过(不插重复行)`);
    return null;
  }
  const mergedCount = fields.merged_events ?? (Number(existing.merged_events) || 1) + 1;
  console.log(
    `[pool] ${existing.symbol} 同票候选合并 #${existing.id}(第${mergedCount}个事件,基础分 ${existing.base_score}${stronger ? ` → ${incoming.base_score}` : ' 保持'})`
  );
  return { ...existing, ...fields, updated_at: data[0].updated_at };
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

/** 候选池预览(宏观页/交易页):活跃候选按当前分倒序;不可用返回 null */
export async function listPoolPreview(limit = 10) {
  if (!isPoolAvailable()) return null;
  const baseColumns =
    'id, symbol, tier, sentiment, confidence, final_confidence, sector, current_score, base_score, status, status_reason, macro_regime, created_at, expires_at';
  // entry_price(016)/merged_events、last_signal_at(022)为可选列:
  // 老库缺列时逐列剥离重试,预览不因迁移未执行而整体消失
  let optional = OPTIONAL_CANDIDATE_COLUMNS.filter((c) => !missingCandidateColumns.has(c));
  const query = (cols) =>
    supabase()
      .from('candidate_signals')
      .select(cols.length ? `${baseColumns}, ${cols.join(', ')}` : baseColumns)
      .in('status', ACTIVE_STATUSES)
      .order('current_score', { ascending: false, nullsFirst: false })
      .limit(limit);
  let { data, error } = await query(optional);
  while (error && /column|schema/i.test(error.message)) {
    const col = optional.find((c) => error.message.includes(c));
    if (!col) break;
    optional = optional.filter((c) => c !== col);
    ({ data, error } = await query(optional));
  }
  if (error) {
    if (isMissingTable(error)) warnMissingOnce();
    return null;
  }
  return data || [];
}
