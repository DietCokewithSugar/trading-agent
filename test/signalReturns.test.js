import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDailyForwardReturns } from '../server/services/signalReturns.js';

const rows = [
  { date: '2026-06-01', price: 100 },
  { date: '2026-06-02', price: 102 },
  { date: '2026-06-03', price: 101 },
  { date: '2026-06-04', price: 105 },
  { date: '2026-06-05', price: 104 },
  { date: '2026-06-08', price: 110 },
];

test('信号日之后第 1/2 个交易日收盘的前瞻收益(百分比)', () => {
  const { r1d, r2d } = computeDailyForwardReturns({
    rows,
    signalEtDate: '2026-06-01',
    signalPrice: 100,
  });
  assert.equal(r1d, 2); // 6/2 收盘 102
  assert.equal(r2d, 1); // 第 2 个交易日 6/3 收盘 101
});

test('信号落在周末:从下一个交易日起算', () => {
  const { r1d } = computeDailyForwardReturns({
    rows,
    signalEtDate: '2026-06-06', // 周六
    signalPrice: 104,
  });
  // 6/8 是其后第一个交易日:110/104 - 1
  assert.equal(r1d, Math.round((110 / 104 - 1) * 100 * 10000) / 10000);
});

test('交易日不足时返回 null,而不是用更短窗口冒充', () => {
  const { r1d, r2d } = computeDailyForwardReturns({
    rows,
    signalEtDate: '2026-06-05',
    signalPrice: 104,
  });
  assert.equal(r1d, Math.round((110 / 104 - 1) * 100 * 10000) / 10000);
  assert.equal(r2d, null);
});

test('信号价非法时不产出数据', () => {
  const r = computeDailyForwardReturns({ rows, signalEtDate: '2026-06-01', signalPrice: 0 });
  assert.deepEqual(r, { r1d: null, r2d: null });
});
