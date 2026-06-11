import { config } from '../config.js';

/**
 * 进程内运行指标(可观测性层):
 * - 当日累计:LLM 调用/Token/估算成本(按用途分桶)、FMP/DeepSeek 错误计数与最近样本;
 * - 当前运行累加器:runCycle 进行中的 LLM 用量、供应商错误、交易拒绝原因,
 *   结束时由 endRun 取走并随 cycle_runs 落库。
 * 全部为同步内存操作,绝无 I/O,任何调用点都不会因指标统计影响交易主链路(fail-open)。
 *
 * 归因说明:runCycle 受 cycleStatus.running 单飞保护,同一时刻最多一轮在跑,
 * 但运行期间并发发生的后台 LLM 调用(平仓复盘/每日复查/队列成交)会被计入重叠的那一轮——
 * 可观测性允许这种近似;若未来需要精确归因,可升级为 AsyncLocalStorage。
 */

const RECENT_ERROR_LIMIT = 20;

/** 美东日界的日期键(YYYY-MM-DD),当日计数按此惰性翻日 */
export function etDayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** 按配置单价估算一次 LLM 调用的成本(美元),保留 6 位小数 */
export function estimateLlmCost(
  { promptTokens = 0, completionTokens = 0 } = {},
  pricing = { inputPer1M: config.deepseekCostPer1MInput, outputPer1M: config.deepseekCostPer1MOutput }
) {
  const input = Number(promptTokens) || 0;
  const output = Number(completionTokens) || 0;
  const cost = (input / 1e6) * pricing.inputPer1M + (output / 1e6) * pricing.outputPer1M;
  return Math.round(cost * 1e6) / 1e6;
}

function emptyDay(key) {
  return {
    key,
    llm: { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, cost: 0, byPurpose: {} },
    providerErrors: {
      fmp: { count: 0, recent: [] },
      deepseek: { count: 0, recent: [] },
    },
  };
}

let day = emptyDay(etDayKey());
let currentRun = null;

function ensureDay() {
  const key = etDayKey();
  if (day.key !== key) day = emptyDay(key);
  return day;
}

function purposeBucket(purpose) {
  const key = purpose || 'other';
  if (!day.llm.byPurpose[key]) {
    day.llm.byPurpose[key] = { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, latencyMsTotal: 0 };
  }
  return day.llm.byPurpose[key];
}

/**
 * 记录一次 LLM 调用(deepseek.js#chatJSONWithMeta 调用)。
 * purpose: analyst | trader | risk-officer | event-matcher | review | reflection
 */
export function recordLlmCall({ purpose, promptTokens = 0, completionTokens = 0, latencyMs = 0, ok = true } = {}) {
  ensureDay();
  const bucket = purposeBucket(purpose);
  bucket.calls += 1;
  bucket.latencyMsTotal += latencyMs;
  day.llm.calls += 1;
  if (!ok) {
    bucket.errors += 1;
    day.llm.errors += 1;
  }
  const cost = estimateLlmCost({ promptTokens, completionTokens });
  bucket.promptTokens += promptTokens;
  bucket.completionTokens += completionTokens;
  day.llm.promptTokens += promptTokens;
  day.llm.completionTokens += completionTokens;
  day.llm.cost = Math.round((day.llm.cost + cost) * 1e6) / 1e6;
  if (currentRun) {
    currentRun.llmCalls += 1;
    currentRun.llmPromptTokens += promptTokens;
    currentRun.llmCompletionTokens += completionTokens;
    currentRun.llmCost = Math.round((currentRun.llmCost + cost) * 1e6) / 1e6;
  }
}

/** 记录一次上游供应商错误(provider: 'fmp' | 'deepseek'),保留最近样本供管理页排障 */
export function recordProviderError(provider, message) {
  ensureDay();
  const bucket = day.providerErrors[provider];
  if (!bucket) return;
  bucket.count += 1;
  bucket.recent.push({ at: new Date().toISOString(), message: String(message || '').slice(0, 300) });
  if (bucket.recent.length > RECENT_ERROR_LIMIT) bucket.recent.shift();
  if (currentRun) {
    if (provider === 'fmp') currentRun.fmpErrors += 1;
    else if (provider === 'deepseek') currentRun.deepseekErrors += 1;
  }
}

/** runCycle 进入时调用:开启当前运行累加器 */
export function beginRun({ runId, trigger = 'scheduler' } = {}) {
  currentRun = {
    runId,
    trigger,
    llmCalls: 0,
    llmPromptTokens: 0,
    llmCompletionTokens: 0,
    llmCost: 0,
    fmpErrors: 0,
    deepseekErrors: 0,
    rejectReasons: {},
  };
}

/** runCycle 结束时调用:取走本轮累加结果并清空(无运行时返回空统计) */
export function endRun() {
  const stats = currentRun || beginRunStatsFallback();
  currentRun = null;
  return stats;
}

function beginRunStatsFallback() {
  return {
    runId: null,
    trigger: null,
    llmCalls: 0,
    llmPromptTokens: 0,
    llmCompletionTokens: 0,
    llmCost: 0,
    fmpErrors: 0,
    deepseekErrors: 0,
    rejectReasons: {},
  };
}

/** 当前运行的 run_id(analyzeAndStore / handleSignal 写库关联用),无运行时返回 null */
export function currentRunId() {
  return currentRun?.runId ?? null;
}

/** 记录一次交易链路拒绝原因(去重/门槛/核验/风控/熔断等);无运行时为 no-op */
export function recordReject(reason) {
  if (!currentRun || !reason) return;
  currentRun.rejectReasons[reason] = (currentRun.rejectReasons[reason] || 0) + 1;
}

/** 管理接口读取:当日 LLM 用量(总量 + 按用途分桶)与供应商错误 */
export function getTodayMetrics() {
  ensureDay();
  return {
    date: day.key,
    llm: {
      calls: day.llm.calls,
      errors: day.llm.errors,
      promptTokens: day.llm.promptTokens,
      completionTokens: day.llm.completionTokens,
      cost: day.llm.cost,
      byPurpose: Object.fromEntries(
        Object.entries(day.llm.byPurpose).map(([k, v]) => [k, { ...v }])
      ),
    },
    providerErrors: {
      fmp: { count: day.providerErrors.fmp.count, recent: [...day.providerErrors.fmp.recent] },
      deepseek: {
        count: day.providerErrors.deepseek.count,
        recent: [...day.providerErrors.deepseek.recent],
      },
    },
  };
}

/** 管理重置时调用:清空进程内全部指标状态 */
export function resetMetrics() {
  day = emptyDay(etDayKey());
  currentRun = null;
}

/**
 * 对外文案脱敏:公开接口与 SSE 广播中的错误信息不得出现上游供应商名称
 * (供应商信息只允许出现在 token 门控的管理面),完整原文随 cycle_runs 落库。
 */
export function sanitizeProviderText(text) {
  return String(text || '').replace(/deepseek|fmp|yahoo/gi, '上游服务');
}
