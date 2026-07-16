import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSharpe,
  maxDrawdownPercent,
  annualizedReturnPercent,
  summarize,
} from '../server/services/backtest/metrics.js';

test('computeSharpe:样本不足或零波动为 null,常规序列手算校验', () => {
  assert.equal(computeSharpe([100, 110]), null);
  assert.equal(computeSharpe([100, 110, 121]), null); // 两个收益完全相同 → std=0
  // [100,110,100]:收益 [0.1, −0.090909…],均值 0.0045455,样本 std 0.1349931
  // → 0.0336723 × √252 = 0.5345…,round2 = 0.53
  assert.equal(computeSharpe([100, 110, 100]), 0.53);
});

test('maxDrawdownPercent:峰谷回撤', () => {
  assert.equal(maxDrawdownPercent([100, 120, 90, 110]), 25);
  assert.equal(maxDrawdownPercent([100, 110, 120]), 0);
  assert.equal(maxDrawdownPercent([]), 0);
});

test('annualizedReturnPercent:252 交易日年化', () => {
  assert.equal(annualizedReturnPercent(110, 100, 253), 10); // 恰一年(252 个回报期)
  assert.equal(annualizedReturnPercent(110, 100, 1), null); // 样本不足
  assert.equal(annualizedReturnPercent(0, 100, 30), null);
});

test('summarize:CR/胜率/交易计数与 Wilson CI', () => {
  const equity = Array.from({ length: 10 }, (_, i) => ({
    date: `2026-01-${String(i + 5).padStart(2, '0')}`,
    value: 10000 + i * 100,
    pct: i,
  }));
  const trades = [
    { side: 'buy', price: 100, quantity: 100 },
    { side: 'sell', price: 102, quantity: 100, realized_pnl: 200 },
    { side: 'buy', price: 101, quantity: 100 },
    { side: 'sell', price: 100, quantity: 100, realized_pnl: -100 },
  ];
  const s = summarize({ equity, trades, initialValue: 10000 });
  assert.equal(s.cr_percent, 9); // 10900/10000 − 1
  assert.equal(s.trade_count, 4);
  assert.equal(s.sell_count, 2);
  assert.equal(s.win_count, 1);
  assert.equal(s.win_rate, 50);
  assert.ok(s.win_rate_ci && s.win_rate_ci.lo < 50 && s.win_rate_ci.hi > 50);
  assert.ok(s.arr_percent > 0);
  assert.equal(s.final_value, 10900);
});

test('summarize:无卖出时胜率为 null', () => {
  const s = summarize({ equity: [{ date: 'd', value: 10000, pct: 0 }], trades: [], initialValue: 10000 });
  assert.equal(s.win_rate, null);
  assert.equal(s.win_rate_ci, null);
  assert.equal(s.cr_percent, 0);
});
