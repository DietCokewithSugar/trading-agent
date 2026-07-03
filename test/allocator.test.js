import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tierScore,
  decayFactor,
  scoreCandidate,
  mergeBySymbol,
  rankCandidates,
  planAllocations,
  shouldWriteScore,
} from '../server/services/allocator.js';

const NOW = new Date('2026-06-11T15:00:00Z');

test('tierScore 表与 decayFactor 曲线', () => {
  assert.equal(tierScore(1), 1.0);
  assert.equal(tierScore(2), 0.75);
  assert.equal(tierScore(3), 0.35);
  assert.equal(tierScore(4), 0.15);
  assert.equal(decayFactor(0.5), 1, '1 小时内不衰减');
  assert.equal(decayFactor(24), 0.5);
  assert.equal(decayFactor(48), 0.5, '下限 0.5');
  assert.equal(decayFactor(NaN), 0.7, '无效年龄按 0.7');
});

test('scoreCandidate:乘数链与缺省值', () => {
  const fresh = {
    tier: 1,
    confidence: 0.8,
    source_score: 0.9,
    created_at: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
  };
  assert.equal(scoreCandidate(fresh, { now: NOW }), Number((1 * 0.8 * 1 * 0.9).toFixed(3)));
  // 宏观/行业乘数叠乘
  assert.equal(
    scoreCandidate(fresh, { now: NOW, macroMultiplier: 0.5, sectorMult: 0.8 }),
    Number((0.72 * 0.5 * 0.8).toFixed(3))
  );
  // 置信度/来源缺省 0.7;25 小时衰减到 0.5
  const stale = { tier: 2, created_at: new Date(NOW.getTime() - 25 * 3600_000).toISOString() };
  assert.equal(scoreCandidate(stale, { now: NOW }), Number((0.75 * 0.7 * 0.5 * 0.7).toFixed(3)));
});

test('scoreCandidate:last_signal_at 为衰减锚点,缺失回退 created_at', () => {
  const merged = {
    tier: 1,
    confidence: 0.8,
    source_score: 0.9,
    created_at: new Date(NOW.getTime() - 30 * 3600_000).toISOString(), // 首次入池已 30 小时
    last_signal_at: new Date(NOW.getTime() - 30 * 60_000).toISOString(), // 最新事件 30 分钟前
  };
  assert.equal(
    scoreCandidate(merged, { now: NOW }),
    Number((1 * 0.8 * 1 * 0.9).toFixed(3)),
    '合并续命后按最新事件时刻不衰减'
  );
  const legacy = { ...merged, last_signal_at: undefined };
  assert.equal(
    scoreCandidate(legacy, { now: NOW }),
    Number((1 * 0.8 * 0.5 * 0.9).toFixed(3)),
    '旧行回退 created_at,30 小时衰减到下限 0.5'
  );
});

test('mergeBySymbol:取最高分代表,多事件共振加成上限 +0.1', () => {
  const candidates = [
    { id: 1, symbol: 'NVDA', score: 0.6 },
    { id: 2, symbol: 'NVDA', score: 0.8 },
    { id: 3, symbol: 'AAPL', score: 0.5 },
  ];
  const { merged, absorbed } = mergeBySymbol(candidates);
  const nvda = merged.find((c) => c.symbol === 'NVDA');
  assert.equal(nvda.id, 2, '最高分为代表');
  assert.equal(nvda.score, 0.85, '+0.05 共振加成');
  assert.equal(absorbed.length, 1);
  assert.equal(absorbed[0].candidate.id, 1);
  // 4 条同票:加成封顶 +0.1
  const many = mergeBySymbol([
    { symbol: 'TSLA', score: 0.5 },
    { symbol: 'TSLA', score: 0.4 },
    { symbol: 'TSLA', score: 0.3 },
    { symbol: 'TSLA', score: 0.2 },
  ]);
  assert.equal(many.merged[0].score, 0.6);
});

test('mergeBySymbol:事件数按 merged_events 之和(022 入池即合并后单行携带计数)', () => {
  // 单行 merged_events=2:与旧的两行重复候选同等加成
  const single = mergeBySymbol([{ symbol: 'NVDA', score: 0.6, merged_events: 2 }]);
  assert.equal(single.merged[0].score, 0.65, '单行 2 个事件 → +0.05');
  // 单行 merged_events=5:封顶 +0.1
  const capped = mergeBySymbol([{ symbol: 'NVDA', score: 0.6, merged_events: 5 }]);
  assert.equal(capped.merged[0].score, 0.7);
  // legacy 多行(存量重复,安全网)与带计数的行混合:按求和计事件
  const mixed = mergeBySymbol([
    { id: 1, symbol: 'TSLA', score: 0.6, merged_events: 2 },
    { id: 2, symbol: 'TSLA', score: 0.4 }, // 旧行无计数按 1
  ]);
  assert.equal(mixed.merged[0].id, 1, '最高分为代表');
  assert.equal(mixed.merged[0].score, 0.7, 'Σ=3 个事件 → +0.1');
  assert.equal(mixed.absorbed.length, 1);
});

test('rankCandidates:分数降序,同分按综合置信度、入池时间', () => {
  const ranked = rankCandidates([
    { id: 1, score: 0.5, final_confidence: 0.4, created_at: '2026-06-11T10:00:00Z' },
    { id: 2, score: 0.8, final_confidence: 0.4, created_at: '2026-06-11T10:00:00Z' },
    { id: 3, score: 0.5, final_confidence: 0.6, created_at: '2026-06-11T11:00:00Z' },
    { id: 4, score: 0.5, final_confidence: 0.4, created_at: '2026-06-11T09:00:00Z' },
  ]);
  assert.deepEqual(
    ranked.map((c) => c.id),
    [2, 3, 4, 1]
  );
});

test('shouldWriteScore:状态变化永远写,纯分数刷新按阈值过滤', () => {
  assert.equal(
    shouldWriteScore({ prevScore: 0.5, nextScore: 0.5005, statusChanged: true }),
    true,
    '状态变化即使分数几乎不变也要写'
  );
  assert.equal(
    shouldWriteScore({ prevScore: 0.5, nextScore: 0.505, statusChanged: false }),
    false,
    '低于阈值的纯分数变化跳过写入'
  );
  assert.equal(shouldWriteScore({ prevScore: 0.5, nextScore: 0.52, statusChanged: false }), true);
  assert.equal(
    shouldWriteScore({ prevScore: null, nextScore: 0.5, statusChanged: false }),
    true,
    '首次刷分(prev 缺失)必须写'
  );
  assert.equal(
    shouldWriteScore({ prevScore: 0.5, nextScore: 0.4, statusChanged: false, threshold: 0.2 }),
    false,
    '自定义阈值生效'
  );
});

test('planAllocations:maxPerRun 截断与最低分过滤', () => {
  const ranked = [
    { id: 1, score: 0.8 },
    { id: 2, score: 0.6 },
    { id: 3, score: 0.4 },
    { id: 4, score: 0.01 },
  ];
  assert.deepEqual(
    planAllocations({ ranked, maxPerRun: 2 }).map((c) => c.id),
    [1, 2]
  );
  assert.deepEqual(
    planAllocations({ ranked, maxPerRun: 10 }).map((c) => c.id),
    [1, 2, 3],
    '低于 minScore 的尾部不执行'
  );
  assert.equal(planAllocations({ ranked, maxPerRun: 0 }).length, 0);
});
