import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSignals, executionDateOf } from '../server/services/backtest/aiSignals.js';

const GATES = {
  symbol: 'AAPL',
  tradeTierThreshold: 2,
  minFinalConfidence: 0.35,
  pressBullishPenalty: 0.75,
};

// 高可信基准行:0.95 × 0.9 × 1.0(时效钉发布时刻)× 1.0(一档)= 0.855
const baseRow = {
  url: 'https://example.com/a',
  title: '示例新闻',
  source: 'fmp-stock',
  source_domain: 'reuters.com',
  source_score: 0.95,
  publisher: 'Reuters',
  published_at: '2026-03-06T15:00:00Z', // 周五 10:00 ET,盘中
  relevant: true,
  analysis_symbol: 'AAPL',
  sentiment: 'bullish',
  tier: 1,
  confidence: 0.9,
};

test('executionDateOf:收盘前当日成交,收盘后/周末顺延,DST 与半日市正确处理', () => {
  // 周五 10:00 ET(盘中)→ 当日
  assert.equal(executionDateOf('2026-03-06T15:00:00Z'), '2026-03-06');
  // 周五 16:30 ET(收盘后)→ 下周一
  assert.equal(executionDateOf('2026-03-06T21:30:00Z'), '2026-03-09');
  // 周六 → 下周一
  assert.equal(executionDateOf('2026-03-07T15:00:00Z'), '2026-03-09');
  // DST 已生效(2026-03-08 切换):20:30Z = 16:30 EDT(收盘后)→ 次日;按 EST 误算会得 15:30 当日
  assert.equal(executionDateOf('2026-03-09T20:30:00Z'), '2026-03-10');
  // 感恩节次日半日市(2026-11-27,13:00 收盘):18:30Z = 13:30 ET → 顺延下周一
  assert.equal(executionDateOf('2026-11-27T18:30:00Z'), '2026-11-30');
  // 半日市 12:30 ET(收盘前)→ 当日
  assert.equal(executionDateOf('2026-11-27T17:30:00Z'), '2026-11-27');
  // 无发布时间 → null(不得落到 1970 epoch)
  assert.equal(executionDateOf(null), null);
});

test('deriveSignals:镜像实盘可交易门,逐项丢弃计数', () => {
  const rows = [
    baseRow,                                                         // 保留
    { ...baseRow, url: 'u1', relevant: false },                      // irrelevant
    { ...baseRow, url: 'u2', analysis_symbol: 'MSFT' },              // symbol_mismatch
    { ...baseRow, url: 'u3', sentiment: 'neutral' },                 // neutral
    { ...baseRow, url: 'u4', tier: 3 },                              // low_tier(> 阈值 2)
    { ...baseRow, url: 'u5', confidence: 0.4 },                      // low_confidence(< 0.5)
    { ...baseRow, url: 'u6', source_score: 0.3, confidence: 0.5 },   // below_final_confidence
    { ...baseRow, url: 'u7', published_at: null },                   // no_execution_date
  ];
  const { signals, dropped } = deriveSignals(rows, GATES);
  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0], {
    execution_date: '2026-03-06',
    published_at: baseRow.published_at,
    direction: 'bullish',
    tier: 1,
    confidence: 0.9,
    final_confidence: 0.855,
    url: baseRow.url,
    title: baseRow.title,
  });
  assert.equal(dropped.irrelevant, 1);
  assert.equal(dropped.symbol_mismatch, 1);
  assert.equal(dropped.neutral, 1);
  assert.equal(dropped.low_tier, 1);
  assert.equal(dropped.low_confidence, 1);
  assert.equal(dropped.below_final_confidence, 1);
  assert.equal(dropped.no_execution_date, 1);
});

test('deriveSignals:自述来源利好折价、利空不折价(实盘同口径)', () => {
  // 新闻稿:0.87 × 0.55 × 1.0 × 0.9(二档)= 0.431(round3)
  const press = {
    ...baseRow,
    url: 'p1',
    source: 'fmp-press',
    source_domain: 'prnewswire.com',
    source_score: 0.87,
    confidence: 0.55,
    tier: 2,
  };
  // 利好 ×0.75 = 0.323 < 0.35 → 丢弃
  const bull = deriveSignals([press], GATES);
  assert.equal(bull.signals.length, 0);
  assert.equal(bull.dropped.below_final_confidence, 1);
  // 利空不折价:0.431 ≥ 0.35 → 保留
  const bear = deriveSignals([{ ...press, sentiment: 'bearish' }], GATES);
  assert.equal(bear.signals.length, 1);
  assert.equal(bear.signals[0].final_confidence, 0.431);
});

test('deriveSignals:同日同向归并取最高分,同日多空双双丢弃', () => {
  const merged = deriveSignals(
    [baseRow, { ...baseRow, url: 'm1', confidence: 0.8 }],
    GATES
  );
  assert.equal(merged.signals.length, 1);
  assert.equal(merged.signals[0].final_confidence, 0.855); // 高分那条胜出
  assert.equal(merged.dropped.merged, 1);

  const conflict = deriveSignals(
    [baseRow, { ...baseRow, url: 'c1', sentiment: 'bearish' }],
    GATES
  );
  assert.equal(conflict.signals.length, 0);
  assert.equal(conflict.dropped.conflict, 2);
});

test('deriveSignals:输出按执行日升序', () => {
  const { signals } = deriveSignals(
    [
      { ...baseRow, url: 'later', published_at: '2026-03-09T15:00:00Z' },
      baseRow,
    ],
    GATES
  );
  assert.deepEqual(
    signals.map((s) => s.execution_date),
    ['2026-03-06', '2026-03-09']
  );
});
