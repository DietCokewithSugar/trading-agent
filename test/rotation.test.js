import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRotationSell, pickRotationSellByPnl } from '../server/services/rotation.js';

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

// ── pickRotationSellByPnl:无止盈线组合(trailing_only 系,025)的退化选仓 ──

const pnlPos = (symbol, currentPrice, pnl, pnlPercent) => ({
  symbol,
  current_price: currentPrice,
  take_profit: null,
  unrealized_pnl: pnl,
  unrealized_pnl_percent: pnlPercent,
});

test('pickRotationSellByPnl:选浮盈比例最高的盈利持仓(不看止盈价)', () => {
  const positions = [
    pnlPos('AAA', 105, 50, 5),
    pnlPos('BBB', 120, 30, 20), // 绝对盈利更低但比例最高
    pnlPos('CCC', 95, -10, -5),
  ];
  assert.equal(pickRotationSellByPnl(positions).symbol, 'BBB');
});

test('pickRotationSellByPnl:亏损/零盈亏/缺比例字段的持仓不参与,支持 excludeSymbol', () => {
  assert.equal(pickRotationSellByPnl([pnlPos('LOSS', 95, -10, -5)]), null);
  assert.equal(pickRotationSellByPnl([pnlPos('FLAT', 100, 0, 0)]), null);
  assert.equal(
    pickRotationSellByPnl([{ symbol: 'NOPCT', current_price: 105, unrealized_pnl: 50 }]),
    null,
    '缺 unrealized_pnl_percent 的行不参与'
  );
  const positions = [pnlPos('AAA', 120, 30, 20), pnlPos('BBB', 105, 50, 5)];
  assert.equal(pickRotationSellByPnl(positions, { excludeSymbol: 'AAA' }).symbol, 'BBB');
  assert.equal(pickRotationSellByPnl(null), null);
});
