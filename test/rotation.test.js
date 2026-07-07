import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRotationSell } from '../server/services/rotation.js';

const pos = (symbol, currentPrice, takeProfit, pnl) => ({
  symbol,
  current_price: currentPrice,
  take_profit: takeProfit,
  unrealized_pnl: pnl,
});

test('选出现价/止盈价比值最大(最接近止盈)的盈利持仓', () => {
  const positions = [
    pos('AAA', 101, 102, 50), // 比值 0.990
    pos('BBB', 99, 100, 30), // 比值 0.990(与 AAA 相近但略高:99/100=0.99, 101/102≈0.9902)
    pos('CCC', 95, 102, 10), // 比值 ≈0.931
  ];
  assert.equal(pickRotationSell(positions).symbol, 'AAA');
});

test('亏损持仓与未设止盈的持仓不参与腾位', () => {
  const positions = [
    pos('LOSS', 101, 102, -5), // 亏损:排除
    pos('NOTP', 101, null, 50), // 无止盈价:排除
    pos('OK', 96, 102, 5),
  ];
  assert.equal(pickRotationSell(positions).symbol, 'OK');
});

test('excludeSymbol:候选自身同票不被卖出(禁止卖 X 再买 X)', () => {
  const positions = [pos('AAA', 101, 102, 50), pos('BBB', 96, 102, 5)];
  assert.equal(pickRotationSell(positions, { excludeSymbol: 'AAA' }).symbol, 'BBB');
});

test('无合格持仓返回 null', () => {
  assert.equal(pickRotationSell([]), null);
  assert.equal(pickRotationSell(null), null);
  assert.equal(pickRotationSell([pos('LOSS', 101, 102, -5)]), null);
  // 唯一盈利仓恰是排除对象
  assert.equal(pickRotationSell([pos('AAA', 101, 102, 50)], { excludeSymbol: 'AAA' }), null);
});

test('零盈亏(pnl=0)不算盈利,不参与腾位', () => {
  assert.equal(pickRotationSell([pos('FLAT', 100, 102, 0)]), null);
});

test('pickTopProfit:浮盈比例最高的盈利持仓(trailing 系腾位,025)', async () => {
  const { pickTopProfit } = await import('../server/services/rotation.js');
  const positions = [
    { symbol: 'A', unrealized_pnl: 50, current_price: 110, avg_cost: 100 }, // +10%
    { symbol: 'B', unrealized_pnl: 30, current_price: 60, avg_cost: 50 }, // +20% ← 最高
    { symbol: 'C', unrealized_pnl: -5, current_price: 90, avg_cost: 100 }, // 亏损跳过
    { symbol: 'D', unrealized_pnl: 99, current_price: 130, avg_cost: 100 }, // +30% 但被排除
  ];
  const { default: assert } = await import('node:assert/strict');
  assert.equal(pickTopProfit(positions, { excludeSymbol: 'D' })?.symbol, 'B');
  assert.equal(pickTopProfit([{ symbol: 'X', unrealized_pnl: -1, current_price: 9, avg_cost: 10 }]), null);
  assert.equal(pickTopProfit(null), null);
});
