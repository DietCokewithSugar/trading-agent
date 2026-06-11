import test from 'node:test';
import assert from 'node:assert/strict';
import {
  etDayKey,
  estimateLlmCost,
  recordLlmCall,
  recordProviderError,
  beginRun,
  endRun,
  currentRunId,
  recordReject,
  getTodayMetrics,
  resetMetrics,
  sanitizeProviderText,
} from '../server/services/metrics.js';

test('etDayKey:按美东时区取日期键(跨日边界)', () => {
  // UTC 2026-06-11 03:00 = 美东 2026-06-10 23:00(EDT)
  assert.equal(etDayKey(new Date('2026-06-11T03:00:00Z')), '2026-06-10');
  // UTC 2026-06-11 05:00 = 美东 2026-06-11 01:00
  assert.equal(etDayKey(new Date('2026-06-11T05:00:00Z')), '2026-06-11');
});

test('estimateLlmCost:按单价折算并保留精度', () => {
  const pricing = { inputPer1M: 0.56, outputPer1M: 1.68 };
  assert.equal(estimateLlmCost({ promptTokens: 1_000_000, completionTokens: 0 }, pricing), 0.56);
  assert.equal(estimateLlmCost({ promptTokens: 0, completionTokens: 1_000_000 }, pricing), 1.68);
  // 500k 输入 + 100k 输出 = 0.28 + 0.168
  assert.equal(estimateLlmCost({ promptTokens: 500_000, completionTokens: 100_000 }, pricing), 0.448);
  // 0 与缺省入参不报错
  assert.equal(estimateLlmCost({}, pricing), 0);
  assert.equal(estimateLlmCost(undefined, pricing), 0);
});

test('recordLlmCall:累加当日总量与按用途分桶', () => {
  resetMetrics();
  recordLlmCall({ purpose: 'analyst', promptTokens: 1000, completionTokens: 200, latencyMs: 800, ok: true });
  recordLlmCall({ purpose: 'analyst', promptTokens: 500, completionTokens: 100, latencyMs: 600, ok: true });
  recordLlmCall({ purpose: 'trader', latencyMs: 90000, ok: false });

  const m = getTodayMetrics();
  assert.equal(m.llm.calls, 3);
  assert.equal(m.llm.errors, 1);
  assert.equal(m.llm.promptTokens, 1500);
  assert.equal(m.llm.completionTokens, 300);
  assert.ok(m.llm.cost > 0);
  assert.equal(m.llm.byPurpose.analyst.calls, 2);
  assert.equal(m.llm.byPurpose.analyst.latencyMsTotal, 1400);
  assert.equal(m.llm.byPurpose.trader.errors, 1);
  resetMetrics();
});

test('运行累加器:beginRun/recordReject/endRun 聚合且取走后清空', () => {
  resetMetrics();
  assert.equal(currentRunId(), null);
  // 无运行时 recordReject 为 no-op,不抛错
  recordReject('event_dedup');

  beginRun({ runId: 'run-1', trigger: 'scheduler' });
  assert.equal(currentRunId(), 'run-1');
  recordLlmCall({ purpose: 'analyst', promptTokens: 100, completionTokens: 50, latencyMs: 100, ok: true });
  recordProviderError('fmp', '请求超时');
  recordProviderError('deepseek', '请求失败 500');
  recordReject('llm_hold');
  recordReject('llm_hold');
  recordReject('price_drift_abort');

  const stats = endRun();
  assert.equal(stats.llmCalls, 1);
  assert.equal(stats.llmPromptTokens, 100);
  assert.equal(stats.llmCompletionTokens, 50);
  assert.ok(stats.llmCost > 0);
  assert.equal(stats.fmpErrors, 1);
  assert.equal(stats.deepseekErrors, 1);
  assert.deepEqual(stats.rejectReasons, { llm_hold: 2, price_drift_abort: 1 });

  // 取走后清空:再次 endRun 返回空统计
  assert.equal(currentRunId(), null);
  const empty = endRun();
  assert.equal(empty.llmCalls, 0);
  assert.deepEqual(empty.rejectReasons, {});
  resetMetrics();
});

test('recordProviderError:计数持续增长,最近样本封顶 20 条', () => {
  resetMetrics();
  for (let i = 0; i < 25; i += 1) recordProviderError('fmp', `错误 ${i}`);
  const m = getTodayMetrics();
  assert.equal(m.providerErrors.fmp.count, 25);
  assert.equal(m.providerErrors.fmp.recent.length, 20);
  assert.equal(m.providerErrors.fmp.recent[0].message, '错误 5');
  assert.equal(m.providerErrors.fmp.recent[19].message, '错误 24');
  // 未知 provider 静默忽略
  recordProviderError('unknown', 'x');
  resetMetrics();
});

test('sanitizeProviderText:公开文案不出现供应商名', () => {
  assert.equal(
    sanitizeProviderText('FMP /quote 请求失败 500: DeepSeek 超时, Yahoo RSS 不可用'),
    '上游服务 /quote 请求失败 500: 上游服务 超时, 上游服务 RSS 不可用'
  );
  assert.equal(sanitizeProviderText(null), '');
  assert.equal(sanitizeProviderText('普通错误信息'), '普通错误信息');
});
