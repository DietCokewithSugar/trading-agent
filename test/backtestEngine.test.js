import test from 'node:test';
import assert from 'node:assert/strict';
import { runTargetStrategy, runAiStrategy } from '../server/services/backtest/engine.js';

const bar = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c });
const flatBar = (date, price) => bar(date, price, price, price, price);
const bullish = (date) => ({ execution_date: date, direction: 'bullish', final_confidence: 0.8 });
const bearish = (date) => ({ execution_date: date, direction: 'bearish', final_confidence: 0.8 });

test('runTargetStrategy:昨收盘决定、今收盘执行(shift-1)', () => {
  const bars = [flatBar('2026-01-05', 100), flatBar('2026-01-06', 110), flatBar('2026-01-07', 105)];
  const { equity, trades } = runTargetStrategy({ bars, targets: [1, 1, 0], initialValue: 10000 });
  // targets[0]=1 在第 2 根收盘(110)执行;第 3 根 desired=targets[1]=1 继续持有
  assert.equal(trades.length, 1);
  assert.deepEqual(trades[0], {
    date: '2026-01-06',
    side: 'buy',
    price: 110,
    quantity: 90.9091,
    amount: 10000,
    trigger: 'signal',
  });
  assert.deepEqual(equity.map((p) => p.value), [10000, 10000, 9545.45]);
  assert.equal(equity[2].pct, -4.5455);
});

test('runTargetStrategy:买入持有在首根收盘建仓', () => {
  const bars = [flatBar('2026-01-05', 100), flatBar('2026-01-06', 105)];
  const { equity, trades } = runTargetStrategy({
    bars,
    targets: [1, 1],
    initialValue: 10000,
    entryAtFirstBar: true,
  });
  assert.equal(trades[0].date, '2026-01-05');
  assert.deepEqual(equity.map((p) => p.pct), [0, 5]);
});

test('runTargetStrategy:固定 bps 成本双边生效', () => {
  const bars = [flatBar('2026-01-05', 100), flatBar('2026-01-06', 100)];
  const { equity, trades } = runTargetStrategy({
    bars,
    targets: [0, 0],
    initialValue: 10000,
    costBps: 100, // 1%
    entryAtFirstBar: true,
  });
  assert.equal(trades[0].price, 101); // 买入 100 × 1.01
  // 价格不动,纯成本损耗:10000/101 × 100 = 9900.99
  assert.equal(equity[1].value, 9900.99);
});

test('runAiStrategy:利好建仓 → 盘中触及止盈按止盈价成交', () => {
  const bars = [flatBar('2026-01-05', 100), bar('2026-01-06', 101, 103, 100, 101)];
  const { trades, equity } = runAiStrategy({ bars, signals: [bullish('2026-01-05')], initialValue: 10000 });
  assert.equal(trades[0].trigger, 'news');
  assert.equal(trades[0].price, 100);
  assert.deepEqual(
    { trigger: trades[1].trigger, price: trades[1].price, pnl: trades[1].realized_pnl },
    { trigger: 'take_profit', price: 102, pnl: 200 }
  );
  assert.equal(equity[1].value, 10200);
});

test('runAiStrategy:同根 K 线止损止盈皆触 → 先止损(保守)', () => {
  const bars = [flatBar('2026-01-05', 100), bar('2026-01-06', 100, 103, 97, 100)];
  const { trades } = runAiStrategy({ bars, signals: [bullish('2026-01-05')], initialValue: 10000 });
  assert.equal(trades[1].trigger, 'stop_loss');
  assert.equal(trades[1].price, 98);
  assert.equal(trades[1].realized_pnl, -200);
});

test('runAiStrategy:跳空按开盘价成交,不给括号价优待', () => {
  const gapDown = runAiStrategy({
    bars: [flatBar('2026-01-05', 100), bar('2026-01-06', 96, 99, 95, 97)],
    signals: [bullish('2026-01-05')],
    initialValue: 10000,
  });
  assert.equal(gapDown.trades[1].trigger, 'stop_loss');
  assert.equal(gapDown.trades[1].price, 96);
  const gapUp = runAiStrategy({
    bars: [flatBar('2026-01-05', 100), bar('2026-01-06', 104, 105, 103, 104)],
    signals: [bullish('2026-01-05')],
    initialValue: 10000,
  });
  assert.equal(gapUp.trades[1].trigger, 'take_profit');
  assert.equal(gapUp.trades[1].price, 104);
});

test('runAiStrategy:48 小时持有上限落在第 2 个交易日收盘', () => {
  const bars = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map((d) => flatBar(d, 100));
  const { trades } = runAiStrategy({
    bars,
    signals: [bullish('2026-01-05')],
    initialValue: 10000,
    maxHoldHours: 48,
  });
  assert.equal(trades.length, 2);
  assert.equal(trades[1].trigger, 'max_hold');
  assert.equal(trades[1].date, '2026-01-07');
  assert.equal(trades[1].realized_pnl, 0);
});

test('runAiStrategy:持仓中的新利好刷新持有时钟并上抬止盈(020)', () => {
  const bars = [
    flatBar('2026-01-05', 100),
    flatBar('2026-01-06', 100),
    bar('2026-01-07', 100, 102.5, 100, 100), // 原止盈 102 会触发,上抬到 103 后不触发
    flatBar('2026-01-08', 100),
  ];
  const { trades } = runAiStrategy({
    bars,
    signals: [bullish('2026-01-05'), bullish('2026-01-06')],
    initialValue: 10000,
    maxHoldHours: 48,
    takeProfitStepPercent: 1,
  });
  assert.equal(trades.length, 2);
  // 时钟从 01-06 起算 48h → 01-08 收盘 max_hold(未被 01-07 的 102.5 止盈截胡)
  assert.equal(trades[1].trigger, 'max_hold');
  assert.equal(trades[1].date, '2026-01-08');
});

test('runAiStrategy:利空信号收盘全平;空仓时利空不动作', () => {
  const bars = [flatBar('2026-01-05', 100), flatBar('2026-01-06', 101)];
  const sold = runAiStrategy({
    bars,
    signals: [bullish('2026-01-05'), bearish('2026-01-06')],
    initialValue: 10000,
  });
  assert.equal(sold.trades[1].trigger, 'news');
  assert.equal(sold.trades[1].side, 'sell');
  assert.equal(sold.trades[1].price, 101);
  const flat = runAiStrategy({ bars, signals: [bearish('2026-01-05')], initialValue: 10000 });
  assert.equal(flat.trades.length, 0);
});

test('runAiStrategy:执行日缺 K 线(数据缺口)顺延到下一根成交', () => {
  const bars = [flatBar('2026-01-05', 100), flatBar('2026-01-07', 102)];
  const { trades } = runAiStrategy({ bars, signals: [bullish('2026-01-06')], initialValue: 10000 });
  assert.equal(trades[0].date, '2026-01-07');
  assert.equal(trades[0].price, 102);
});

test('runAiStrategy:窗口结束不强平,按市值计入净值', () => {
  const bars = [flatBar('2026-01-05', 100), flatBar('2026-01-06', 101)];
  const { equity, trades, endState } = runAiStrategy({
    bars,
    signals: [bullish('2026-01-05')],
    initialValue: 10000,
    maxHoldHours: 0, // 关闭持有上限
  });
  assert.equal(trades.length, 1);
  assert.equal(endState.holding, true);
  assert.equal(equity[1].value, 10100);
});

test('runTargetStrategy:windowStart 暖机段只供指标取值,交易与净值从窗口首日开始', () => {
  // 暖机段 3 根 + 窗口 2 根;targets 在暖机末根(idx2)已给出满仓信号
  const bars = [
    flatBar('2026-01-02', 90),
    flatBar('2026-01-05', 95),
    flatBar('2026-01-06', 100),
    flatBar('2026-01-07', 102), // 窗口首根:执行 targets[2]=1 → 建仓
    flatBar('2026-01-08', 104),
  ];
  const { equity, trades } = runTargetStrategy({
    bars,
    targets: [0, 0, 1, 1, 1],
    initialValue: 10000,
    windowStart: '2026-01-07',
  });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].date, '2026-01-07');
  assert.equal(trades[0].price, 102);
  // 净值只含窗口内两点,首点即窗口首日
  assert.deepEqual(equity.map((p) => p.date), ['2026-01-07', '2026-01-08']);
  assert.equal(equity[0].pct, 0);
});

test('runTargetStrategy:windowStart 下买入持有在窗口首根建仓(而非暖机首根)', () => {
  const bars = [flatBar('2026-01-05', 50), flatBar('2026-01-06', 100), flatBar('2026-01-07', 110)];
  const { equity, trades } = runTargetStrategy({
    bars,
    targets: [1, 1, 1],
    initialValue: 10000,
    entryAtFirstBar: true,
    windowStart: '2026-01-06',
  });
  assert.equal(trades[0].date, '2026-01-06');
  assert.equal(trades[0].price, 100);
  assert.deepEqual(equity.map((p) => p.pct), [0, 10]);
});

test('runAiStrategy:windowStart 下净值日期轴与基线一致', () => {
  const bars = [flatBar('2026-01-05', 100), flatBar('2026-01-06', 100), flatBar('2026-01-07', 101)];
  const { equity, trades } = runAiStrategy({
    bars,
    signals: [bullish('2026-01-06')],
    initialValue: 10000,
    maxHoldHours: 0,
    windowStart: '2026-01-06',
  });
  assert.deepEqual(equity.map((p) => p.date), ['2026-01-06', '2026-01-07']);
  assert.equal(trades[0].date, '2026-01-06');
  assert.equal(equity[1].value, 10100);
});
