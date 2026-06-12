import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSignals, pearson, wilsonInterval } from '../server/services/signalStats.js';

function signal(overrides) {
  return {
    sentiment: 'bullish',
    tier: 1,
    confidence: 0.8,
    final_confidence: 0.6,
    source_score: 0.9,
    traded: false,
    fwd_return_1h: null,
    fwd_return_1d: null,
    fwd_return_5d: null,
    ...overrides,
  };
}

test('命中率按信号方向调整:利空下跌算命中', () => {
  const rows = [
    signal({ sentiment: 'bullish', fwd_return_1d: 2 }), // 命中
    signal({ sentiment: 'bullish', fwd_return_1d: -1 }), // 未命中
    signal({ sentiment: 'bearish', fwd_return_1d: -3 }), // 命中(方向调整后 +3)
    signal({ sentiment: 'bearish', fwd_return_1d: 1 }), // 未命中
  ];
  const { groups } = summarizeSignals(rows);
  const overall = groups.find((g) => g.key === 'overall').rows.find((r) => r.label === '全部');
  assert.equal(overall.n_1d, 4);
  assert.equal(overall.hit_1d, 50);
  // 方向调整收益均值:(2 - 1 + 3 - 1) / 4 = 0.75
  assert.equal(overall.avg_1d, 0.75);
});

test('未回填的口径不计入样本', () => {
  const rows = [
    signal({ fwd_return_1h: 1, fwd_return_1d: null }),
    signal({ fwd_return_1h: null, fwd_return_1d: 2 }),
  ];
  const overall = summarizeSignals(rows)
    .groups.find((g) => g.key === 'overall')
    .rows.find((r) => r.label === '全部');
  assert.equal(overall.n_1h, 1);
  assert.equal(overall.n_1d, 1);
  assert.equal(overall.n_5d, 0);
  assert.equal(overall.hit_5d, null);
});

test('按档位/已交易分桶', () => {
  const rows = [
    signal({ tier: 1, traded: true, fwd_return_1d: 5 }),
    signal({ tier: 2, traded: false, fwd_return_1d: -2 }),
  ];
  const { groups, traded_count, total } = summarizeSignals(rows);
  assert.equal(total, 2);
  assert.equal(traded_count, 1);
  const tierRows = groups.find((g) => g.key === 'tier').rows;
  assert.equal(tierRows.find((r) => r.label === '第1档').hit_1d, 100);
  assert.equal(tierRows.find((r) => r.label === '第2档').hit_1d, 0);
  const tradedRows = groups.find((g) => g.key === 'traded').rows;
  assert.equal(tradedRows.find((r) => r.label === '已交易').n_1d, 1);
});

test('按宏观环境分桶:入池快照为准,未入池信号落兜底桶', () => {
  const rows = [
    signal({ macro_regime: 'risk_on', fwd_return_1d: 2 }),
    signal({ macro_regime: 'risk_off', fwd_return_1d: -1 }),
    signal({ fwd_return_1d: 1 }), // 无 macro_regime 字段(未入池/迁移前数据)
  ];
  const regimeRows = summarizeSignals(rows).groups.find((g) => g.key === 'regime').rows;
  assert.equal(regimeRows.find((r) => r.label === '风险偏好').n_1d, 1);
  assert.equal(regimeRows.find((r) => r.label === '避险').n_1d, 1);
  assert.equal(regimeRows.find((r) => r.label === '未入池').n_1d, 1);
  assert.equal(regimeRows.find((r) => r.label === '中性'), undefined, '空桶不出现');
});

test('执行路径与排队时长分桶 + pooling 聚合', () => {
  const rows = [
    // 即时路径成交(无排队度量)
    signal({ traded: true, fwd_return_1h: 2 }),
    // 入池成交:10 分钟 / 90 分钟 / 5 小时
    signal({ traded: true, pool_wait_minutes: 10, pool_drift_percent: 0.5, fwd_return_1h: 1 }),
    signal({ traded: true, pool_wait_minutes: 90, pool_drift_percent: 1.5, fwd_return_1h: -1 }),
    signal({ traded: true, pool_wait_minutes: 300, pool_drift_percent: null, fwd_return_1h: 0.5 }),
    // 未交易信号不进该分组
    signal({ traded: false, fwd_return_1h: 3 }),
  ];
  const { groups, pooling } = summarizeSignals(rows);
  const pathRows = groups.find((g) => g.key === 'exec_path').rows;
  assert.equal(pathRows.find((r) => r.label === '即时成交').n_1h, 1);
  assert.equal(pathRows.find((r) => r.label === '入池成交(全部)').n_1h, 3);
  assert.equal(pathRows.find((r) => r.label === '入池 ≤15 分钟').n_1h, 1);
  assert.equal(pathRows.find((r) => r.label === '入池 1~4 小时').n_1h, 1);
  assert.equal(pathRows.find((r) => r.label === '入池 >4 小时').n_1h, 1);
  assert.equal(pooling.n, 3);
  assert.equal(pooling.avg_wait_minutes, Math.round(((10 + 90 + 300) / 3) * 10) / 10);
  assert.equal(pooling.avg_drift_percent, 1, '漂移均值只算有值的样本');
});

test('IC:综合置信度与方向调整收益完全同序时接近 1', () => {
  const rows = [
    signal({ final_confidence: 0.3, fwd_return_1d: 1 }),
    signal({ final_confidence: 0.5, fwd_return_1d: 3 }),
    signal({ final_confidence: 0.7, fwd_return_1d: 5 }),
    signal({ final_confidence: 0.9, fwd_return_1d: 7 }),
  ];
  const { ic } = summarizeSignals(rows);
  assert.ok(ic['1d'] > 0.99);
  assert.equal(ic['1h'], null, '无样本的口径为 null');
});

test('pearson:样本不足或零方差返回 null', () => {
  assert.equal(pearson([1, 2], [1, 2]), null);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null);
  assert.ok(Math.abs(pearson([1, 2, 3], [3, 2, 1]) + 1) < 1e-9);
});

test('wilsonInterval:小样本区间宽、大样本区间窄、边界钳制在 [0,100]', () => {
  assert.equal(wilsonInterval(0, 0), null);
  // 10 中 6:点估计 60%,但 95% 区间跨过 50%(样本不足以下结论)
  const small = wilsonInterval(6, 10);
  assert.ok(small.lo < 50 && small.hi > 50);
  // 1000 中 600:同为 60%,区间收窄到 50% 以上
  const big = wilsonInterval(600, 1000);
  assert.ok(big.lo > 50 && big.hi < 70);
  assert.ok(big.hi - big.lo < small.hi - small.lo, '样本越大区间越窄');
  // 全中/全不中不越界
  assert.equal(wilsonInterval(5, 5).hi <= 100, true);
  assert.equal(wilsonInterval(0, 5).lo >= 0, true);
});

test('命中率带 Wilson 置信区间字段', () => {
  const rows = [
    signal({ fwd_return_1d: 1 }),
    signal({ fwd_return_1d: 2 }),
    signal({ fwd_return_1d: -1 }),
  ];
  const overall = summarizeSignals(rows)
    .groups.find((g) => g.key === 'overall')
    .rows.find((r) => r.label === '全部');
  assert.equal(overall.hit_1d, 66.67);
  assert.ok(overall.hit_lo_1d !== null && overall.hit_lo_1d < 66.67);
  assert.ok(overall.hit_hi_1d !== null && overall.hit_hi_1d > 66.67);
  // 无样本口径区间为 null
  assert.equal(overall.hit_lo_1h, null);
});

test('拦截层机会成本分桶:风控官否决/候选过期单列,且不落入兜底桶', () => {
  const rows = [
    signal({ traded: true, fwd_return_1d: 1 }),
    signal({ candidate_status: 'rejected', officer_veto: true, fwd_return_1d: -4 }),
    signal({ candidate_status: 'expired', fwd_return_1d: 2 }),
    signal({ candidate_status: 'rejected', officer_veto: false, fwd_return_1d: 3 }),
    signal({ candidate_status: 'macro_filtered', fwd_return_1d: 5 }),
  ];
  const tradedRows = summarizeSignals(rows).groups.find((g) => g.key === 'traded').rows;
  assert.equal(tradedRows.find((r) => r.label === '风控官否决').n_1d, 1);
  assert.equal(tradedRows.find((r) => r.label === '风控官否决').avg_1d, -4);
  assert.equal(tradedRows.find((r) => r.label === '候选过期/取消').n_1d, 1);
  assert.equal(tradedRows.find((r) => r.label === '宏观过滤').avg_1d, 5);
  // 非风控官的 rejected 落兜底桶
  assert.equal(tradedRows.find((r) => r.label === '其他未交易(去重/挂起/否决)').n_1d, 1);
});
