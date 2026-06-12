import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeShadowSpend,
  applyBuy,
  applySell,
  unscaleFraction,
  pickTopBlocked,
  valuePositions,
} from '../server/services/shadowEngine.js';

const caps = { maxBuyCashFraction: 0.2, maxPositionFraction: 0.25, minOrderAmount: 50 };

test('computeShadowSpend: 比例×总值与单笔现金帽取小', () => {
  // 10% × 100k = 10000,低于 20% 单笔帽与现金
  assert.equal(
    computeShadowSpend({ fraction: 0.1, cash: 50000, totalValue: 100000, caps }),
    10000
  );
  // 50% 请求被单笔帽钳到 20% × 100k = 20000
  assert.equal(
    computeShadowSpend({ fraction: 0.5, cash: 50000, totalValue: 100000, caps }),
    20000
  );
  // 现金不足时按现金
  assert.equal(computeShadowSpend({ fraction: 0.5, cash: 3000, totalValue: 100000, caps }), 3000);
});

test('computeShadowSpend: 单票持仓帽与最小金额', () => {
  // 已持有 24k,买后不得超过 25% × 100k = 25k → 只能再买 1000
  assert.equal(
    computeShadowSpend({ fraction: 0.1, cash: 50000, totalValue: 100000, positionValue: 24000, caps }),
    1000
  );
  // 帽后低于下限 → 0(跳过)
  assert.equal(
    computeShadowSpend({ fraction: 0.1, cash: 50000, totalValue: 100000, positionValue: 24980, caps }),
    0
  );
  assert.equal(computeShadowSpend({ fraction: 0.0001, cash: 50000, totalValue: 100000, caps }), 0);
});

test('computeShadowSpend: benchmark 全仓建仓只受现金约束', () => {
  assert.equal(
    computeShadowSpend({ fraction: 1, cash: 100000, totalValue: 100000, benchmark: true, caps }),
    100000
  );
  // 非法输入返回 0
  assert.equal(computeShadowSpend({ fraction: 1, cash: 0, totalValue: 100000, caps }), 0);
  assert.equal(computeShadowSpend({ fraction: 0, cash: 100000, totalValue: 100000, caps }), 0);
});

test('applyBuy: 开新仓按成交价均价并设止损/止盈', () => {
  const pos = applyBuy(null, { quantity: 10, amount: 1000, stopLossPercent: 8, takeProfitPercent: 20 });
  assert.equal(pos.quantity, 10);
  assert.equal(pos.avg_cost, 100);
  assert.equal(pos.stop_loss, 92);
  assert.equal(pos.take_profit, 120);
});

test('applyBuy: 加仓为加权平均成本,不传止损时保留原值', () => {
  const existing = { quantity: 10, avg_cost: 100, stop_loss: 92, take_profit: 120 };
  const pos = applyBuy(existing, { quantity: 10, amount: 1200 });
  assert.equal(pos.quantity, 20);
  assert.equal(pos.avg_cost, 110); // (10×100 + 1200) / 20
  assert.equal(pos.stop_loss, 92);
  assert.equal(pos.take_profit, 120);
});

test('applySell: 部分卖出与盈亏', () => {
  const settle = applySell({ quantity: 20, avg_cost: 100 }, 0.5, 110);
  assert.equal(settle.quantity, 10);
  assert.equal(settle.remaining, 10);
  assert.equal(settle.amount, 1100);
  assert.equal(settle.realizedPnl, 100);
});

test('applySell: fraction≥0.99 或余量过小时清仓', () => {
  assert.equal(applySell({ quantity: 20, avg_cost: 100 }, 1, 90).remaining, 0);
  assert.equal(applySell({ quantity: 20, avg_cost: 100 }, 0.99, 90).quantity, 20);
  // 余量低于 0.0001 股按清仓处理
  const tiny = applySell({ quantity: 10.00005, avg_cost: 100 }, 0.99999, 100);
  assert.equal(tiny.remaining, 0);
});

test('unscaleFraction: 还原消融层缩放,非法系数不放大', () => {
  assert.equal(unscaleFraction(0.05, 0.5), 0.1); // 风控官缩仓 ×0.5 → 还原翻倍
  assert.equal(unscaleFraction(0.05, 1), 0.05); // 未缩放
  assert.equal(unscaleFraction(0.05, 0), 0.05); // scale=0 不除(避免 Infinity)
  assert.equal(unscaleFraction(0.05, null), 0.05);
  assert.equal(unscaleFraction(0, 0.5), 0);
});

test('pickTopBlocked: 按当前分降序取前 N,跳过已买与缺 analysis_id 的', () => {
  const candidates = [
    { symbol: 'A', analysis_id: 1, current_score: 0.5 },
    { symbol: 'B', analysis_id: 2, current_score: 0.9 },
    { symbol: 'C', analysis_id: 3, current_score: 0.7 },
    { symbol: 'D', analysis_id: null, current_score: 1.0 },
  ];
  const picked = pickTopBlocked(candidates, { max: 2, excludeAnalysisIds: new Set([2]) });
  assert.deepEqual(picked.map((c) => c.symbol), ['C', 'A']);
  assert.equal(pickTopBlocked(candidates, { max: 0 }).length, 0);
  assert.equal(pickTopBlocked(null).length, 0);
});

test('valuePositions: 报价缺失退回平均成本', () => {
  const positions = [
    { symbol: 'A', quantity: 10, avg_cost: 100 },
    { symbol: 'B', quantity: 5, avg_cost: 50 },
  ];
  const prices = new Map([['A', 110]]);
  const { positionsValue, totalValue } = valuePositions(positions, prices, 1000);
  assert.equal(positionsValue, 1350); // 10×110 + 5×50
  assert.equal(totalValue, 2350);
});
