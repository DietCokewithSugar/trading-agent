import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tierScore,
  signalStrength,
  resolveConflicts,
  sweepOpposingPairs,
} from '../server/services/conflictResolver.js';

function buyCandidate(overrides = {}) {
  return { symbol: 'NVDA', tier: 2, final_confidence: 0.6, ...overrides };
}

function bearSignal(overrides = {}) {
  return { symbol: 'NVDA', sentiment: 'bearish', tier: 2, final_confidence: 0.6, ...overrides };
}

test('signalStrength:置信度 × 档位分,缺失置信度按 0.5', () => {
  assert.equal(signalStrength({ final_confidence: 0.8, tier: 1 }), 0.8);
  assert.equal(signalStrength({ final_confidence: 0.8, tier: 2 }), 0.8 * 0.75);
  assert.equal(signalStrength({ tier: 1 }), 0.5);
  assert.equal(tierScore(99), 0.15, '未知档位按最低档');
});

test('resolveConflicts:无冲突放行', () => {
  const r = resolveConflicts({ buyCandidates: [buyCandidate()], recentOpposingSignals: [] });
  assert.equal(r.allowed.length, 1);
  assert.equal(r.held.length + r.cancelled.length + r.reducedSize.length, 0);
});

test('resolveConflicts:同票 pending 卖单 → 搁置', () => {
  const r = resolveConflicts({
    buyCandidates: [buyCandidate()],
    pendingSellOrders: [{ symbol: 'NVDA', side: 'sell', status: 'pending' }],
  });
  assert.equal(r.held.length, 1);
  assert.equal(r.allowed.length, 0);
});

test('resolveConflicts:利空明显更强且持仓 → 取消;未持仓 → 搁置', () => {
  const args = {
    buyCandidates: [buyCandidate({ final_confidence: 0.4 })],
    recentOpposingSignals: [bearSignal({ tier: 1, final_confidence: 0.9 })], // 0.9 vs 0.3 = 3×
  };
  const holding = resolveConflicts({ ...args, positions: [{ symbol: 'NVDA' }] });
  assert.equal(holding.cancelled.length, 1, '持仓时取消买入候选');
  const notHolding = resolveConflicts({ ...args, positions: [] });
  assert.equal(notHolding.held.length, 1, '未持仓时搁置');
  assert.equal(notHolding.cancelled.length, 0);
});

test('resolveConflicts:强度相当 → 搁置(恰 1.5× 边界归入"明显更强")', () => {
  // 双方同档同置信:比值 1 < 1.5 → 搁置
  const even = resolveConflicts({
    buyCandidates: [buyCandidate()],
    recentOpposingSignals: [bearSignal()],
  });
  assert.equal(even.held.length, 1);
  // 买方恰为 1.5×:tier1 conf0.9(0.9)vs tier1 conf0.6(0.6)
  const exact = resolveConflicts({
    buyCandidates: [buyCandidate({ tier: 1, final_confidence: 0.9 })],
    recentOpposingSignals: [bearSignal({ tier: 1, final_confidence: 0.6 })],
  });
  assert.equal(exact.reducedSize.length, 1, '恰好 1.5× 视为明显更强');
});

test('resolveConflicts:利好明显更强 → 缩半仓放行;risk_off 下一律搁置', () => {
  const args = {
    buyCandidates: [buyCandidate({ tier: 1, final_confidence: 0.9 })],
    recentOpposingSignals: [bearSignal({ tier: 4, final_confidence: 0.5 })], // 0.9 vs 0.075
  };
  const normal = resolveConflicts({ ...args, regime: 'neutral' });
  assert.equal(normal.reducedSize.length, 1);
  assert.equal(normal.reducedSize[0].scale, 0.5);
  const riskOff = resolveConflicts({ ...args, regime: 'risk_off' });
  assert.equal(riskOff.held.length, 1, '避险下多空冲突一律搁置');
  assert.equal(riskOff.reducedSize.length, 0);
});

test('resolveConflicts:利空信号只影响同票候选', () => {
  const r = resolveConflicts({
    buyCandidates: [buyCandidate({ symbol: 'AAPL' })],
    recentOpposingSignals: [bearSignal({ symbol: 'NVDA', tier: 1, final_confidence: 0.9 })],
  });
  assert.equal(r.allowed.length, 1);
});

test('sweepOpposingPairs:找出与待开盘卖单同票的买入候选', () => {
  const candidates = [buyCandidate({ symbol: 'AAPL' }), buyCandidate({ symbol: 'TSLA' })];
  const orders = [
    { symbol: 'TSLA', side: 'sell', status: 'pending' },
    { symbol: 'AAPL', side: 'buy', status: 'pending' },
  ];
  const hits = sweepOpposingPairs(candidates, orders);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].symbol, 'TSLA');
});
