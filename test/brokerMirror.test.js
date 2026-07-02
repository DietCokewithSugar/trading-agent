import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mirrorLimitPrice,
  signedDiffBps,
  adjustSellQty,
  summarizeMirror,
} from '../server/services/brokerMirror.js';

test('mirrorLimitPrice:买入向上穿价、卖出向下穿价,两位小数', () => {
  assert.equal(mirrorLimitPrice({ side: 'buy', price: 100, slackPercent: 1 }), 101);
  assert.equal(mirrorLimitPrice({ side: 'sell', price: 100, slackPercent: 1 }), 99);
  assert.equal(mirrorLimitPrice({ side: 'buy', price: 12.345, slackPercent: 0.5 }), 12.41);
  // slack=0 即按内部价挂限价
  assert.equal(mirrorLimitPrice({ side: 'sell', price: 50, slackPercent: 0 }), 50);
  // 非法入参
  assert.equal(mirrorLimitPrice({ side: 'buy', price: 0, slackPercent: 1 }), null);
  assert.equal(mirrorLimitPrice({ side: 'buy', price: 100, slackPercent: -1 }), null);
});

test('signedDiffBps:正值 = 对我们不利(买更贵/卖更便宜)', () => {
  // 买入:券商 101 vs 内部 100 → +100bps(买贵了,不利)
  assert.equal(signedDiffBps({ side: 'buy', internalPrice: 100, brokerPrice: 101 }), 100);
  // 买入:券商更便宜 → 负值(有利)
  assert.equal(signedDiffBps({ side: 'buy', internalPrice: 100, brokerPrice: 99.5 }), -50);
  // 卖出:券商 99 vs 内部 100 → +100bps(卖便宜了,不利)
  assert.equal(signedDiffBps({ side: 'sell', internalPrice: 100, brokerPrice: 99 }), 100);
  // 卖出:券商更贵 → 负值(有利)
  assert.equal(signedDiffBps({ side: 'sell', internalPrice: 100, brokerPrice: 100.2 }), -20);
  // 非法入参
  assert.equal(signedDiffBps({ side: 'buy', internalPrice: 0, brokerPrice: 100 }), null);
  assert.equal(signedDiffBps({ side: 'buy', internalPrice: 100, brokerPrice: null }), null);
});

test('adjustSellQty:不超过券商持仓,余量 <0.01 清干净,无持仓返回 0', () => {
  assert.equal(adjustSellQty({ internalQty: 10, brokerQty: 10 }), 10);
  // 券商持仓不足:按券商侧全清
  assert.equal(adjustSellQty({ internalQty: 10, brokerQty: 7 }), 7);
  // 内部卖 9.995、券商有 10 → 余量 0.005 < 0.01,直接清 10
  assert.equal(adjustSellQty({ internalQty: 9.995, brokerQty: 10 }), 10);
  // 余量 ≥0.01 保持部分卖出
  assert.equal(adjustSellQty({ internalQty: 5, brokerQty: 10 }), 5);
  assert.equal(adjustSellQty({ internalQty: 5, brokerQty: 0 }), 0);
  assert.equal(adjustSellQty({ internalQty: 0, brokerQty: 10 }), 0);
});

test('summarizeMirror:成交率/偏差聚合,skipped/error 不进分母', () => {
  const orders = [
    { side: 'buy', status: 'filled', diff_bps: 10 },
    { side: 'buy', status: 'filled', diff_bps: -4 },
    { side: 'sell', status: 'filled', diff_bps: 6 },
    { side: 'buy', status: 'expired', diff_bps: null }, // 未成交
    { side: 'buy', status: 'submitted', diff_bps: null }, // 在途
    { side: 'sell', status: 'skipped', diff_bps: null }, // 未提交,不进分母
    { side: 'buy', status: 'error', diff_bps: null },
  ];
  const s = summarizeMirror(orders);
  assert.equal(s.orders, 5);
  assert.equal(s.filled, 3);
  assert.equal(s.fill_rate, 60);
  assert.equal(s.unfilled, 1);
  assert.equal(s.pending, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.errors, 1);
  // 平均带符号偏差 (10-4+6)/3 = 4;平均绝对偏差 (10+4+6)/3 ≈ 6.7
  assert.equal(s.avg_bps, 4);
  assert.equal(s.avg_abs_bps, 6.7);
  assert.equal(s.buy.n, 2);
  assert.equal(s.buy.avg_bps, 3);
  assert.equal(s.sell.n, 1);
  assert.equal(s.sell.avg_bps, 6);
});

test('summarizeMirror:空输入安全', () => {
  const s = summarizeMirror([]);
  assert.equal(s.orders, 0);
  assert.equal(s.fill_rate, null);
  assert.equal(s.avg_bps, null);
  assert.equal(summarizeMirror(null).orders, 0);
});
