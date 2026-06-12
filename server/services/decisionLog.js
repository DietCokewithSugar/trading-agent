// LLM 交易决策可回放(018):每次交易员决策(decideTrade)连同风控官审批落一行
// 完整记录——prompt 版本、发给模型的完整 messages(可原样重放)、输入快照哈希、
// LLM 原始返回、normalized 结果、仓位缩放链各步、决策价/成交价快照与最终结局。
// 没有这层,改 prompt 或换模型后无法区分收益变化来自市场随机、prompt 还是模型;
// 有了完整 messages 与 input_hash,旧信号可以原样发给新 prompt/新模型做离线对比。
//
// 纯观测层,fail-open:任何失败只告警,绝不影响交易主链路;
// 表缺失(未执行 018 迁移)时警告一次后整体停用。
import { createHash } from 'node:crypto';
import { supabase } from '../db.js';
import { config } from '../config.js';

let tableMissing = false;

function isMissingTable(error) {
  return (
    error?.code === 'PGRST205' ||
    (/trade_decisions/.test(error?.message || '') &&
      /not find|does not exist|schema cache/i.test(error?.message || ''))
  );
}

/** 输入快照哈希:messages 的 sha256(同输入跑不同 prompt 版本/模型时按它对齐样本) */
export function hashMessages(messages) {
  return createHash('sha256').update(JSON.stringify(messages ?? null)).digest('hex');
}

/** 从 normalized 决策对象里剥掉 replay 附件(messages/raw 单独成列,不重复入 jsonb) */
export function stripReplay(obj) {
  if (!obj || typeof obj !== 'object') return obj ?? null;
  const { replay, ...rest } = obj;
  return rest;
}

/**
 * 开启一段决策记录(纯函数):decideTrade 返回后立即调用,后续在各退出点
 * 用 finishDecision 落库。decision.replay 由 deepseek.js 附带(messages/raw/版本/时延)。
 */
export function beginDecisionEpisode({
  path,
  symbol,
  article = null,
  analysisRow = null,
  candidateId = null,
  decisionPrice = null,
  decision,
  runId = null,
}) {
  const replay = decision?.replay || {};
  return {
    symbol,
    path,
    run_id: runId,
    news_id: article?.id ?? null,
    analysis_id: analysisRow?.id ?? null,
    candidate_id: candidateId,
    model: config.deepseekModel,
    trader_prompt_version: replay.promptVersion ?? null,
    trader_messages: replay.messages ?? null,
    trader_input_hash: replay.messages ? hashMessages(replay.messages) : null,
    trader_raw: replay.raw ?? null,
    // 决策时点的 normalized 快照(decision 后续会被缩放链原地修改,这里先拷贝)
    trader_decision: stripReplay(decision),
    trader_latency_ms: replay.latencyMs ?? null,
    decision_price: decisionPrice,
    sizing: { llm_fraction: decision?.fraction ?? null },
  };
}

/** 附加风控官审批结果(verdict.replay 同样由 deepseek.js 附带) */
export function attachOfficer(episode, verdict) {
  if (!episode || !verdict) return episode;
  const replay = verdict.replay || {};
  episode.officer_prompt_version = replay.promptVersion ?? null;
  episode.officer_messages = replay.messages ?? null;
  episode.officer_input_hash = replay.messages ? hashMessages(replay.messages) : null;
  episode.officer_raw = replay.raw ?? null;
  episode.officer_verdict = stripReplay(verdict);
  episode.officer_latency_ms = replay.latencyMs ?? null;
  return episode;
}

// trade_decisions 含 jsonb 大字段,逐条插入即可(决策只对头部候选发生,频率很低)
async function insertDecision(row) {
  const { error } = await supabase().from('trade_decisions').insert(row);
  if (error) {
    if (isMissingTable(error)) {
      if (!tableMissing) {
        tableMissing = true;
        console.warn('[decision] trade_decisions 表不可用,决策回放记录停用(请执行 018 迁移)');
      }
      return;
    }
    console.warn(`[decision] ${row.symbol} 决策记录写入失败: ${error.message}`);
  }
}

/**
 * 在决策流程的退出点落库(fire-and-forget,fail-open)。
 * outcome: executed / queued / hold / symbol_invalid / vetoed / officer_error /
 *          rejected / sell_skipped;trade 为成交记录时回填 trade_id 与成交价快照。
 */
export function finishDecision(episode, { outcome, reason = null, trade = null } = {}) {
  if (!episode || tableMissing || !config.enableDecisionLog) return;
  const row = {
    ...episode,
    outcome,
    outcome_reason: reason ? String(reason).slice(0, 300) : null,
    trade_id: trade?.id ?? null,
    fill_price: trade?.price ?? null,
    fill_quote_price: trade?.quote_price ?? null,
  };
  insertDecision(row).catch((err) =>
    console.warn(`[decision] ${episode.symbol} 决策记录写入失败: ${err.message}`)
  );
}

/** 管理接口:最近的决策记录;full=false 时不带大字段(messages/raw)。表缺失返回 null */
export async function listRecentDecisions({ limit = 50, full = false } = {}) {
  const lightColumns =
    'id, symbol, path, run_id, news_id, analysis_id, candidate_id, trade_id, model, ' +
    'trader_prompt_version, trader_input_hash, trader_decision, trader_latency_ms, ' +
    'officer_prompt_version, officer_input_hash, officer_verdict, officer_latency_ms, ' +
    'sizing, decision_price, fill_price, fill_quote_price, outcome, outcome_reason, created_at';
  const { data, error } = await supabase()
    .from('trade_decisions')
    .select(full ? '*' : lightColumns)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingTable(error)) return null;
    throw new Error(error.message);
  }
  return data || [];
}
