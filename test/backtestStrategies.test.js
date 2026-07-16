import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buyHoldTargets,
  macdTargets,
  kdjRsiTargets,
  zmrTargets,
  smaTargets,
} from '../server/services/backtest/strategies.js';

const toBars = (closes) => closes.map((c) => ({ high: c, low: c, close: c }));

test('buyHoldTargets:恒满仓', () => {
  assert.deepEqual(buyHoldTargets(toBars([1, 2, 3])), [1, 1, 1]);
});

test('smaTargets:快慢均线上/下穿,暖机与相等保持', () => {
  // fast=2: [null,1.5,2.5,2.5,1.5];slow=3: [null,null,2,2.3333,2]
  const targets = smaTargets(toBars([1, 2, 3, 2, 1]), { fast: 2, slow: 3 });
  assert.deepEqual(targets, [0, 0, 1, 1, 0]);
});

test('zmrTargets:显著低于均值进场,回归均值离场', () => {
  const closes = [...new Array(19).fill(10), 8, 10, 10];
  // idx19:z≈−4.25 ≤ −1 → 进;idx20:z≈+0.22 ≥ 0 → 出;idx21 保持空仓
  const targets = zmrTargets(toBars(closes), { period: 20, entryZ: -1, exitZ: 0 });
  assert.deepEqual(targets, [...new Array(19).fill(0), 1, 0, 0]);
});

test('macdTargets:上升趋势持仓,趋势反转离场', () => {
  // 用指数增长/衰减序列:等差直线会让 hist 收敛到 ±1e-6,符号不具判别力
  const closes = [
    ...Array.from({ length: 45 }, (_, i) => 100 * 1.05 ** i),
    ...Array.from({ length: 20 }, (_, i) => 100 * 1.05 ** 44 * 0.93 ** (i + 1)),
  ];
  const targets = macdTargets(toBars(closes), { fast: 12, slow: 26, signal: 9 });
  // hist 自 idx33 起有值;加速上升段 hist > 0 → 满仓
  assert.ok(targets.slice(0, 33).every((t) => t === 0), '暖机期应空仓');
  assert.equal(targets[35], 1, '上升趋势中应持仓');
  assert.equal(targets[targets.length - 1], 0, '下跌趋势尾部应已离场');
});

test('kdjRsiTargets:RSI 单边驱动(KDJ 阈值设为不可触发)', () => {
  // rsi period 3:连跌 3 根 → RSI 0 进场;连涨后 RSI ≥ 70 离场
  const targets = kdjRsiTargets(toBars([10, 9, 8, 7, 8, 9, 10]), {
    kdj: { period: 3, k: 3, d: 3, oversold: -1, overbought: 101 },
    rsi: { period: 3, oversold: 30, overbought: 70 },
  });
  assert.deepEqual(targets, [0, 0, 0, 1, 1, 1, 0]);
});

test('kdjRsiTargets:KDJ 单边驱动(RSI 阈值设为不可触发)', () => {
  const bars = [
    { high: 10, low: 8, close: 9 },
    { high: 10, low: 8, close: 9 },
    { high: 10, low: 8, close: 8 },   // RSV 0 → J 急落 ≤ 20 进场
    { high: 10, low: 8, close: 8 },
    { high: 10, low: 8, close: 8 },
    { high: 12, low: 8, close: 12 },  // RSV 100 → J 回升
    { high: 12, low: 8, close: 12 },  // J ≥ 80 离场
    { high: 12, low: 8, close: 12 },
  ];
  const targets = kdjRsiTargets(bars, {
    kdj: { period: 3, k: 3, d: 3, oversold: 20, overbought: 80 },
    rsi: { period: 14, oversold: -1, overbought: 101 },
  });
  assert.deepEqual(targets, [0, 0, 1, 1, 1, 1, 0, 0]);
});
