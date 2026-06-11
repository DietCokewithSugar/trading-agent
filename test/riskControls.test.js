import test from 'node:test';
import assert from 'node:assert/strict';
import { etDayKey } from '../server/services/metrics.js';
import {
  etMidnightUtcIso,
  computeDayPnlPercent,
  updateDailyLossState,
  checkMaxPositions,
  sectorCapHeadroom,
  lossStreakMultiplier,
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

test('lossStreakMultiplier:连亏打折、盈亏混合/样本不足/关闭均为 1', () => {
  const opts = { count: 3, scale: 0.5 };
  assert.equal(lossStreakMultiplier([-10, -5, -1], opts), 0.5);
  assert.equal(lossStreakMultiplier([-10, 5, -1], opts), 1, '有盈利不触发');
  assert.equal(lossStreakMultiplier([-10, -5], opts), 1, '样本不足不触发');
  assert.equal(lossStreakMultiplier([-10, -5, -1, 99], opts), 0.5, '只看最近 count 笔');
  assert.equal(lossStreakMultiplier([-10, -5, -1], { count: 3, scale: 1 }), 1, 'scale=1 关闭');
  assert.equal(lossStreakMultiplier([-10, -5, -1], { count: 0, scale: 0.5 }), 1, 'count=0 关闭');
});
