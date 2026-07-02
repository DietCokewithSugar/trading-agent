import test from 'node:test';
import assert from 'node:assert/strict';
import { holdAnchor, isHoldExpired, bumpTakeProfit } from '../server/services/holding.js';

const NOW = new Date('2026-07-02T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();

test('holdAnchor:优先 hold_refreshed_at,回退 opened_at,皆缺返回 null', () => {
  const refreshed = hoursAgo(1);
  const opened = hoursAgo(10);
  assert.equal(holdAnchor({ hold_refreshed_at: refreshed, opened_at: opened }), new Date(refreshed).getTime());
  assert.equal(holdAnchor({ opened_at: opened }), new Date(opened).getTime());
  assert.equal(holdAnchor({}), null);
  assert.equal(holdAnchor(null), null);
  // 非法时间串不算锚点
  assert.equal(holdAnchor({ opened_at: 'not-a-date' }), null);
});

test('isHoldExpired:超过时限为真,未超为假', () => {
  assert.equal(isHoldExpired({ opened_at: hoursAgo(49) }, { maxHoldHours: 48, now: NOW }), true);
  assert.equal(isHoldExpired({ opened_at: hoursAgo(47) }, { maxHoldHours: 48, now: NOW }), false);
  // 恰好等于时限不算超(> 语义)
  assert.equal(isHoldExpired({ opened_at: hoursAgo(48) }, { maxHoldHours: 48, now: NOW }), false);
});

test('isHoldExpired:刷新时间重置时钟', () => {
  // 建仓 100 小时前,但 2 小时前刚被新利好刷新 → 未超时
  const pos = { opened_at: hoursAgo(100), hold_refreshed_at: hoursAgo(2) };
  assert.equal(isHoldExpired(pos, { maxHoldHours: 48, now: NOW }), false);
});

test('isHoldExpired:maxHoldHours<=0(关闭)或锚点缺失(未执行 020)一律为假', () => {
  assert.equal(isHoldExpired({ opened_at: hoursAgo(999) }, { maxHoldHours: 0, now: NOW }), false);
  assert.equal(isHoldExpired({ opened_at: hoursAgo(999) }, { maxHoldHours: -1, now: NOW }), false);
  assert.equal(isHoldExpired({}, { maxHoldHours: 48, now: NOW }), false);
});

test('bumpTakeProfit:现有止盈按成本价的 step% 逐次累加', () => {
  // 成本 100,止盈 102(+2%),step 1 → 103
  assert.equal(bumpTakeProfit({ takeProfit: 102, avgCost: 100, stepPercent: 1 }), 103);
  // 再刷新一次 → 104(逐事件累加)
  assert.equal(bumpTakeProfit({ takeProfit: 103, avgCost: 100, stepPercent: 1 }), 104);
  // 四位小数舍入
  assert.equal(bumpTakeProfit({ takeProfit: 10.2, avgCost: 10, stepPercent: 1 }), 10.3);
});

test('bumpTakeProfit:止盈缺失时按 默认止盈+step 初始化', () => {
  // 成本 100,默认止盈 2%,step 1 → 100 × 1.03 = 103
  assert.equal(
    bumpTakeProfit({ takeProfit: null, avgCost: 100, stepPercent: 1, defaultTakeProfitPercent: 2 }),
    103
  );
  // 无默认止盈参数时只按 step 初始化
  assert.equal(bumpTakeProfit({ takeProfit: null, avgCost: 100, stepPercent: 1 }), 101);
});

test('bumpTakeProfit:入参非法时原值返回', () => {
  assert.equal(bumpTakeProfit({ takeProfit: 102, avgCost: 0, stepPercent: 1 }), 102);
  assert.equal(bumpTakeProfit({ takeProfit: 102, avgCost: 100, stepPercent: 0 }), 102);
  assert.equal(bumpTakeProfit({ takeProfit: null, avgCost: null, stepPercent: 1 }), null);
});
