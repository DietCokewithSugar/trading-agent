import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, macd, rsi, kdj, zscore } from '../server/services/backtest/indicators.js';

const approx = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < eps, `期望 ${expected},实得 ${actual}`);

test('sma:暖机期 null,窗口滚动均值', () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  assert.deepEqual(sma([1, 2], 0), [null, null]);
});

test('ema:种子为前 period 均值,k=2/(period+1)', () => {
  assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  assert.deepEqual(ema([1, 2], 3), [null, null]);
});

test('macd:恒定价格下 macd/signal/hist 全为 0', () => {
  const closes = new Array(40).fill(5);
  const { macdLine, signalLine, hist } = macd(closes, { fast: 12, slow: 26, signal: 9 });
  // macdLine 自慢线暖机完成(idx25)起为 0;signal 种子在第 9 个非 null 处(idx33)
  assert.equal(macdLine[24], null);
  approx(macdLine[25], 0);
  assert.equal(signalLine[32], null);
  approx(signalLine[33], 0);
  approx(hist[39], 0);
});

test('rsi:Wilder 平滑,全涨 100,首个回撤后按平滑衰减', () => {
  // 1..15 连涨,idx14 全涨 → 100;idx15 下跌 1 → RSI = 100 − 100/14
  const closes = [...Array.from({ length: 15 }, (_, i) => i + 1), 14];
  const out = rsi(closes, 14);
  assert.equal(out[13], null);
  assert.equal(out[14], 100);
  approx(out[15], 100 - 100 / 14);
  // 恒定价格:涨跌均 0 → 50
  assert.equal(rsi(new Array(16).fill(3), 14)[15], 50);
});

test('kdj:RSV→K→D→J 经典口径(种子 50)', () => {
  const bars = [
    { high: 10, low: 8, close: 9 },
    { high: 11, low: 8, close: 10 },
    { high: 12, low: 8, close: 12 },
  ];
  const { K, D, J } = kdj(bars, { period: 3, k: 3, d: 3 });
  assert.equal(K[1], null);
  // rsv=100:K = 2/3×50 + 1/3×100 = 66.6667;D = 2/3×50 + 1/3×K = 55.5556;J = 3K−2D
  assert.equal(K[2], 66.6667);
  assert.equal(D[2], 55.5556);
  assert.equal(J[2], 88.8889);
  // 区间为 0(高低相等)时 RSV 取 50,K/D/J 保持 50
  const flat = new Array(4).fill({ high: 5, low: 5, close: 5 });
  const r = kdj(flat, { period: 3, k: 3, d: 3 });
  assert.equal(r.K[3], 50);
  assert.equal(r.J[3], 50);
});

test('zscore:样本标准差口径,std 为 0 时 null', () => {
  const out = zscore([1, 2, 3], 3);
  assert.equal(out[1], null);
  approx(out[2], 1); // mean=2, 样本 std=1
  assert.deepEqual(zscore([5, 5, 5], 3), [null, null, null]);
});
