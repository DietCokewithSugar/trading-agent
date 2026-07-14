import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeSignals,
  pearson,
  wilsonInterval,
  pairSellsToBuys,
  summarizeTradeOutcomes,
} from '../server/services/signalStats.js';

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
    fwd_return_2d: null,
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
  assert.equal(overall.n_2d, 0);
  assert.equal(overall.hit_2d, null);
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

// ── 实盘兑现(±2%/48h 策略口径)──

test('pairSellsToBuys:同票最近且不晚于卖出时间的买单,跨票/无买单不配对', () => {
  const buys = [
    { symbol: 'AAA', analysis_id: 1, created_at: '2026-07-01T10:00:00Z' },
    { symbol: 'AAA', analysis_id: 2, created_at: '2026-07-02T10:00:00Z' },
    { symbol: 'BBB', analysis_id: 3, created_at: '2026-07-01T09:00:00Z' },
  ];
  const sells = [
    // AAA 在第二笔买入之后卖出 → 配对到 analysis 2
    { symbol: 'AAA', trigger: 'take_profit', realized_pnl: 5, created_at: '2026-07-02T12:00:00Z' },
    // AAA 在两笔买入之间卖出 → 配对到 analysis 1
    { symbol: 'AAA', trigger: 'stop_loss', realized_pnl: -3, created_at: '2026-07-01T15:00:00Z' },
    // 买入之前的卖出(异常数据)不配对
    { symbol: 'BBB', trigger: 'max_hold', realized_pnl: 1, created_at: '2026-07-01T08:00:00Z' },
    // 无同票买单不配对
    { symbol: 'CCC', trigger: 'news', realized_pnl: 2, created_at: '2026-07-02T12:00:00Z' },
  ];
  const paired = pairSellsToBuys(sells, buys);
  assert.equal(paired.length, 2);
  assert.equal(paired.find((p) => p.trigger === 'take_profit').analysis_id, 2);
  assert.equal(paired.find((p) => p.trigger === 'stop_loss').analysis_id, 1);
});

test('summarizeTradeOutcomes:触发分布/胜率/盈亏聚合与空桶剔除', () => {
  const rows = [
    { trigger: 'take_profit', realized_pnl: 10, tier: 1, source_score: 1.0, is_press: false, is_filing: true },
    { trigger: 'stop_loss', realized_pnl: -8, tier: 1, source_score: 0.9, is_press: false },
    { trigger: 'max_hold', realized_pnl: 2, tier: 2, source_score: 0.5, is_press: true },
    { trigger: 'news', realized_pnl: -1, tier: 2, source_score: 0.5, is_press: false },
  ];
  const { total, buckets } = summarizeTradeOutcomes(rows);
  assert.equal(total, 4);
  const all = buckets.find((b) => b.label === '全部');
  assert.equal(all.n, 4);
  assert.equal(all.take_profit_rate, 25);
  assert.equal(all.stop_loss_rate, 25);
  assert.equal(all.max_hold_rate, 25);
  assert.equal(all.other_rate, 25);
  assert.equal(all.win_rate, 50);
  assert.ok(all.win_lo !== null && all.win_hi !== null);
  assert.equal(all.avg_pnl, 0.75); // (10-8+2-1)/4
  assert.equal(all.total_pnl, 3);
  const tier1 = buckets.find((b) => b.label === '第1档');
  assert.equal(tier1.n, 2);
  assert.equal(tier1.take_profit_rate, 50);
  const press = buckets.find((b) => b.label === '新闻稿来源');
  assert.equal(press.n, 1);
  assert.equal(press.max_hold_rate, 100);
  // 监管披露(SEC 8-K)桶与新闻稿桶口径独立
  const filing = buckets.find((b) => b.label === '监管披露来源');
  assert.equal(filing.n, 1);
  assert.equal(filing.take_profit_rate, 100);
  // 来源低桶只含两条 0.5 分来源
  assert.equal(buckets.find((b) => b.label === '来源低(<0.65)').n, 2);
  // 来源中桶为空,不出现
  assert.equal(buckets.find((b) => b.label === '来源中(0.65~0.85)'), undefined);
});

test('summarizeTradeOutcomes:空输入返回 total=0 且无桶', () => {
  const { total, buckets } = summarizeTradeOutcomes([]);
  assert.equal(total, 0);
  assert.equal(buckets.length, 0);
});
