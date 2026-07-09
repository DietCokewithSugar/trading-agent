import test from 'node:test';
import assert from 'node:assert/strict';
import { etDayKey } from '../server/services/metrics.js';
import {
  etMidnightUtcIso,
  etDayRangeUtc,
  computeDayPnlPercent,
  updateDailyLossState,
  checkMaxPositions,
  sectorCapHeadroom,
  lossStreakMultiplier,
  computeBuyHeadroom,
  updateNewPositionState,
} from '../server/services/riskControls.js';

test('etMidnightUtcIso:EST 与 EDT 日期均换算回美东当日零点', () => {
  // 2026-01-15(EST,UTC-5)与 2026-06-15(EDT,UTC-4)
  for (const now of [new Date('2026-01-15T18:00:00Z'), new Date('2026-06-15T18:00:00Z')]) {
    const midnight = new Date(etMidnightUtcIso(now));
    assert.equal(etDayKey(midnight), etDayKey(now), '日历日不变');
    const hour = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(midnight);
    assert.equal(Number(hour), 0, '美东小时为 0');
  }
});

test('etDayRangeUtc:常规日与 DST 切换日的 [start, end) 范围', () => {
  // 常规夏令日:24 小时
  const jul = etDayRangeUtc('2026-07-09');
  assert.equal(jul.startIso, '2026-07-09T04:00:00.000Z'); // EDT 零点 = UTC 04:00
  assert.equal(jul.endIso, '2026-07-10T04:00:00.000Z');
  // 常规冬令日:EST 零点 = UTC 05:00
  const jan = etDayRangeUtc('2026-01-15');
  assert.equal(jan.startIso, '2026-01-15T05:00:00.000Z');
  assert.equal(jan.endIso, '2026-01-16T05:00:00.000Z');
  // 春令切换日(2026-03-08):23 小时
  const spring = etDayRangeUtc('2026-03-08');
  assert.equal(
    (new Date(spring.endIso) - new Date(spring.startIso)) / 3600_000,
    23
  );
  // 秋令切换日(2026-11-01):25 小时
  const fall = etDayRangeUtc('2026-11-01');
  assert.equal((new Date(fall.endIso) - new Date(fall.startIso)) / 3600_000, 25);
  // 非法输入
  assert.equal(etDayRangeUtc('2026-02-30'), null);
  assert.equal(etDayRangeUtc('not-a-date'), null);
  assert.equal(etDayRangeUtc(null), null);
});

test('computeDayPnlPercent:正常计算与无效基线', () => {
  assert.equal(computeDayPnlPercent(98000, 100000), -2);
  assert.equal(computeDayPnlPercent(101000, 100000), 1);
  assert.equal(computeDayPnlPercent(98000, null), null);
  assert.equal(computeDayPnlPercent(98000, 0), null);
  assert.equal(computeDayPnlPercent(null, 100000), null);
});

test('updateDailyLossState:触发 → 当日 sticky → 换日重置', () => {
  let state = { dayKey: null, tripped: false };
  // 未达阈值不触发
  state = updateDailyLossState(state, { dayKey: '2026-06-15', dayPnlPercent: -1.5, thresholdPercent: 2 });
  assert.equal(state.tripped, false);
  // 达到阈值触发
  state = updateDailyLossState(state, { dayKey: '2026-06-15', dayPnlPercent: -2.1, thresholdPercent: 2 });
  assert.equal(state.tripped, true);
  // 同日盘中反弹仍保持触发(sticky)
  state = updateDailyLossState(state, { dayKey: '2026-06-15', dayPnlPercent: -0.5, thresholdPercent: 2 });
  assert.equal(state.tripped, true);
  // 换日重置
  state = updateDailyLossState(state, { dayKey: '2026-06-16', dayPnlPercent: -0.5, thresholdPercent: 2 });
  assert.equal(state.tripped, false);
});

test('updateDailyLossState:阈值 0 关闭、基线缺失不触发', () => {
  const off = updateDailyLossState(null, { dayKey: 'd', dayPnlPercent: -99, thresholdPercent: 0 });
  assert.equal(off.tripped, false);
  const noBase = updateDailyLossState(null, { dayKey: 'd', dayPnlPercent: null, thresholdPercent: 2 });
  assert.equal(noBase.tripped, false);
});

test('checkMaxPositions:满仓拒新、加仓放行、0 关闭', () => {
  const positions = [{ symbol: 'AAPL' }, { symbol: 'MSFT' }];
  assert.equal(
    checkMaxPositions({ positions, symbol: 'NVDA', maxOpenPositions: 2 }).ok,
    false,
    '满仓时拒绝开新仓'
  );
  assert.equal(
    checkMaxPositions({ positions, symbol: 'AAPL', maxOpenPositions: 2 }).ok,
    true,
    '已持有的加仓放行'
  );
  assert.equal(checkMaxPositions({ positions, symbol: 'NVDA', maxOpenPositions: 3 }).ok, true);
  assert.equal(checkMaxPositions({ positions, symbol: 'NVDA', maxOpenPositions: 0 }).ok, true);
});

test('sectorCapHeadroom:剩余额度、超限归零、0 关闭', () => {
  // cap 35% × $100k = $35k,行业现值 $20k → 还能买 $15k
  assert.equal(
    sectorCapHeadroom({ totalValue: 100000, sectorValue: 20000, maxSectorFraction: 0.35 }),
    15000
  );
  assert.equal(
    sectorCapHeadroom({ totalValue: 100000, sectorValue: 40000, maxSectorFraction: 0.35 }),
    0
  );
  assert.equal(
    sectorCapHeadroom({ totalValue: 100000, sectorValue: 99000, maxSectorFraction: 0 }),
    Infinity
  );
});

test('computeBuyHeadroom:三重钳制各自触发', () => {
  const base = {
    cash: 50000,
    totalValue: 100000,
    positionsValue: 50000,
    spentToday: 0,
    budgetBase: 100000,
  };
  const params = { minCashReserve: 0.25, dailyBuyBudget: 0.35, maxGrossExposure: 0.75 };
  // 不受限:三个余量分别为 25000 / 35000 / 25000
  const free = computeBuyHeadroom({ ...base, spend: 10000, params });
  assert.deepEqual(free, { spend: 10000, clamped: false, binding: null });
  // 现金保留触发:cash 26000 − 25000 = 1000
  const reserve = computeBuyHeadroom({ ...base, spend: 10000, cash: 26000, params });
  assert.equal(reserve.spend, 1000);
  assert.equal(reserve.binding, 'cash_reserve');
  // 当日预算触发:35000 − 34000 = 1000
  const budget = computeBuyHeadroom({ ...base, spend: 10000, spentToday: 34000, params });
  assert.equal(budget.spend, 1000);
  assert.equal(budget.binding, 'daily_budget');
  // 总敞口触发:75000 − 74000 = 1000
  const exposure = computeBuyHeadroom({ ...base, spend: 10000, positionsValue: 74000, params });
  assert.equal(exposure.spend, 1000);
  assert.equal(exposure.binding, 'gross_exposure');
});

test('computeBuyHeadroom:组合触发取最紧约束,额度耗尽归零', () => {
  const params = { minCashReserve: 0.25, dailyBuyBudget: 0.35, maxGrossExposure: 0.75 };
  const r = computeBuyHeadroom({
    spend: 10000,
    cash: 26000, // reserve 余量 1000
    totalValue: 100000,
    positionsValue: 74500, // exposure 余量 500(最紧)
    spentToday: 0,
    budgetBase: 100000,
    params,
  });
  assert.equal(r.spend, 500);
  assert.equal(r.binding, 'gross_exposure');
  // macro_shock 参数集(全 0)→ 额度归零
  const shock = computeBuyHeadroom({
    spend: 10000,
    cash: 100000,
    totalValue: 100000,
    positionsValue: 0,
    params: { minCashReserve: 1, dailyBuyBudget: 0, maxGrossExposure: 0 },
  });
  assert.equal(shock.spend, 0);
  assert.equal(shock.clamped, true);
});

test('computeBuyHeadroom:预算基数缺失退用当前总值', () => {
  const r = computeBuyHeadroom({
    spend: 40000,
    cash: 100000,
    totalValue: 100000,
    positionsValue: 0,
    spentToday: 0,
    budgetBase: null,
    params: { minCashReserve: 0, dailyBuyBudget: 0.35, maxGrossExposure: 1 },
  });
  assert.equal(r.spend, 35000, '按当前总值的 35% 计预算');
  assert.equal(r.binding, 'daily_budget');
});

test('updateNewPositionState:同日去重累计、换日重置', () => {
  let state = null;
  state = updateNewPositionState(state, { dayKey: '2026-06-15', symbol: 'AAPL' });
  state = updateNewPositionState(state, { dayKey: '2026-06-15', symbol: 'MSFT' });
  state = updateNewPositionState(state, { dayKey: '2026-06-15', symbol: 'AAPL' });
  assert.equal(state.symbols.length, 2, '同票重复不累计');
  state = updateNewPositionState(state, { dayKey: '2026-06-16', symbol: 'NVDA' });
  assert.deepEqual(state.symbols, ['NVDA'], '换日重置');
});

test('lossStreakMultiplier:连亏打折、盈亏混合/样本不足/关闭均为 1', () => {
  const opts = { count: 3, scale: 0.5 };
  assert.equal(lossStreakMultiplier([-10, -5, -1], opts), 0.5);
  assert.equal(lossStreakMultiplier([-10, 5, -1], opts), 1, '有盈利不触发');
  assert.equal(lossStreakMultiplier([-10, -5], opts), 1, '样本不足不触发');
  assert.equal(lossStreakMultiplier([-10, -5, -1, 99], opts), 0.5, '只看最近 count 笔');
  assert.equal(lossStreakMultiplier([-10, -5, -1], { count: 3, scale: 1 }), 1, 'scale=1 关闭');
  assert.equal(lossStreakMultiplier([-10, -5, -1], { count: 0, scale: 0.5 }), 1, 'count=0 关闭');
});
