import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyReturns, realizedVolPercent, computeBracket } from '../server/services/volatility.js';

test('dailyReturns:相邻交易日简单收益率(%),非法价格被过滤', () => {
  const rows = [
    { date: '2026-06-01', price: 100 },
    { date: '2026-06-02', price: 102 },
    { date: '2026-06-03', price: 96.9 },
    { date: '2026-06-04', price: null },
    { date: '2026-06-05', price: 96.9 },
  ];
  const returns = dailyReturns(rows);
  assert.equal(returns.length, 3, 'null 价格行被过滤,其余相邻成对');
  assert.ok(Math.abs(returns[0] - 2) < 1e-9, '100 → 102 = +2%');
  assert.ok(Math.abs(returns[1] - -5) < 1e-9, '102 → 96.9 = -5%');
  assert.equal(returns[2], 0);
});

test('realizedVolPercent:样本标准差手算校验,样本不足返回 null', () => {
  // 收益率交替 +1%/-1%(均值 0):样本标准差 = sqrt(n/(n-1)) ≈ 1.0260(n=20)
  const rows = [{ date: 'd0', price: 100 }];
  let price = 100;
  for (let i = 1; i <= 20; i += 1) {
    price = price * (1 + (i % 2 === 1 ? 0.01 : -0.01));
    rows.push({ date: `d${i}`, price });
  }
  const vol = realizedVolPercent(rows);
  assert.ok(Math.abs(vol - Math.sqrt(20 / 19)) < 0.001, `20 个 ±1% 收益的样本标准差 ≈ 1.026,得 ${vol}`);

  // 有效收益 < 10 个 → null(新股/数据洞,波动估计不可信)
  assert.equal(realizedVolPercent(rows.slice(0, 10)), null);
  assert.equal(realizedVolPercent([]), null);
  assert.equal(realizedVolPercent(null), null);
});

test('realizedVolPercent:只取最近 days 个收益', () => {
  // 前段剧烈波动 + 后 20 日完全平稳 → 波动应为 0(剧烈段被窗口截掉)
  const rows = [
    { date: 'a', price: 100 },
    { date: 'b', price: 200 },
    { date: 'c', price: 50 },
  ];
  for (let i = 0; i < 21; i += 1) rows.push({ date: `d${i}`, price: 80 });
  assert.equal(realizedVolPercent(rows), 0);
});

test('computeBracket:clamp 上下限、k 缩放与 null 透传', () => {
  const opts = { k: 1, minPercent: 1.5, maxPercent: 4 };
  assert.equal(computeBracket(2.7, opts), 2.7, '区间内原样');
  assert.equal(computeBracket(0.5, opts), 1.5, '下限钳制');
  assert.equal(computeBracket(9, opts), 4, '上限钳制');
  assert.equal(computeBracket(2, { ...opts, k: 1.5 }), 3, 'k 缩放');
  assert.equal(computeBracket(null, opts), null, 'null 透传(回退固定值)');
  assert.equal(computeBracket(0, opts), null);
  assert.equal(computeBracket(NaN, opts), null);
});
