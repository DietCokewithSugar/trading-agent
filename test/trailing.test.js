import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTrailedStop } from '../server/services/trailing.js';

test('computeTrailedStop:创新高按原距离上抬,峰值同步更新', () => {
  // 成本 100,止损 98(距离 2%),现价 110 → 新止损 110×0.98 = 107.8
  const r = computeTrailedStop({ price: 110, stop: 98, peakPrice: null, avgCost: 100 });
  assert.deepEqual(r, { stop: 107.8, peak: 110 });
  // 有峰值时以峰值为基准:峰值 110、止损 107.8,现价 120 → 120×0.98 = 117.6
  const r2 = computeTrailedStop({ price: 120, stop: 107.8, peakPrice: 110, avgCost: 100 });
  assert.deepEqual(r2, { stop: 117.6, peak: 120 });
});

test('computeTrailedStop:价格未创新高/涨幅不足最小抬升门时不动', () => {
  // 现价未超过基准 → null
  assert.equal(computeTrailedStop({ price: 100, stop: 98, peakPrice: null, avgCost: 100 }), null);
  assert.equal(computeTrailedStop({ price: 105, stop: 102.9, peakPrice: 106, avgCost: 100 }), null);
  // 微涨:新止损 100.3×0.98 = 98.294 < 98×1.005 = 98.49 → 不满足 0.5% 最小抬升,不动
  assert.equal(computeTrailedStop({ price: 100.3, stop: 98, peakPrice: null, avgCost: 100 }), null);
});

test('computeTrailedStop:非法输入与退化距离返回 null', () => {
  assert.equal(computeTrailedStop({ price: 110, stop: 0, avgCost: 100 }), null, '无止损');
  assert.equal(computeTrailedStop({ price: 0, stop: 98, avgCost: 100 }), null, '无价格');
  assert.equal(computeTrailedStop({ price: 110, stop: 98, avgCost: 0 }), null, '基准非法');
  // 止损高于基准(距离 ≤ 0)→ null
  assert.equal(computeTrailedStop({ price: 110, stop: 105, peakPrice: 104, avgCost: 100 }), null);
});
