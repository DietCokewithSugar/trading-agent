import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRegime, sectorMultiplier, mergeMacroConfidence } from '../server/services/macroRegime.js';

const NOW = new Date('2026-06-11T15:00:00Z');

function ev(overrides = {}) {
  return {
    market_impact_tier: 1,
    macro_direction: 'risk_off',
    confidence: 0.9,
    rates_signal: 'neutral',
    inflation_signal: 'neutral',
    growth_signal: 'neutral',
    affected_sectors: [],
    created_at: new Date(NOW.getTime() - 30 * 60_000).toISOString(), // 30 分钟前
    ...overrides,
  };
}

test('aggregateRegime:空事件 → neutral,风险分为 0', () => {
  const r = aggregateRegime({ events: [], now: NOW });
  assert.equal(r.regime, 'neutral');
  assert.equal(r.riskScore, 0);
  assert.equal(r.shockUntil, null);
});

test('aggregateRegime:一档高置信 risk_off → macro_shock,到期解除', () => {
  const events = [ev({ confidence: 0.9 })];
  const shocked = aggregateRegime({ events, now: NOW, cfg: { shockHours: 6 } });
  assert.equal(shocked.regime, 'macro_shock');
  // shockUntil = 事件时间 + 6h
  assert.equal(
    shocked.shockUntil,
    new Date(new Date(events[0].created_at).getTime() + 6 * 3600_000).toISOString()
  );
  // 7 小时后:shock 解除,但事件仍在有效期内 → risk_off
  const later = new Date(NOW.getTime() + 7 * 3600_000);
  const after = aggregateRegime({ events, now: later, cfg: { shockHours: 6 } });
  assert.notEqual(after.regime, 'macro_shock');
  assert.equal(after.shockUntil, null);
});

test('aggregateRegime:低置信/低档位 risk_off 不触发 shock', () => {
  assert.notEqual(
    aggregateRegime({ events: [ev({ confidence: 0.6 })], now: NOW }).regime,
    'macro_shock',
    '置信度不足'
  );
  assert.notEqual(
    aggregateRegime({ events: [ev({ market_impact_tier: 2 })], now: NOW }).regime,
    'macro_shock',
    '档位不足'
  );
});

test('aggregateRegime:时间衰减——同一事件越久影响越弱,超过有效期归零', () => {
  const fresh = aggregateRegime({
    events: [ev({ market_impact_tier: 2, confidence: 0.8 })],
    now: NOW,
  });
  const stale = aggregateRegime({
    events: [
      ev({
        market_impact_tier: 2,
        confidence: 0.8,
        created_at: new Date(NOW.getTime() - 48 * 3600_000).toISOString(),
      }),
    ],
    now: NOW,
  });
  assert.ok(Math.abs(stale.riskScore) < Math.abs(fresh.riskScore), '48 小时前的事件影响更弱');
  const expired = aggregateRegime({
    events: [
      ev({ created_at: new Date(NOW.getTime() - 80 * 3600_000).toISOString() }),
    ],
    now: NOW,
    cfg: { validityHours: 72 },
  });
  assert.equal(expired.regime, 'neutral', '超过有效期的事件不参与聚合');
  assert.equal(expired.riskScore, 0);
});

test('aggregateRegime:滞回——边界分数不来回切换', () => {
  // 构造一个分数落在 0.2~0.3 之间的事件(进入需 >0.3,维持只需 ≥0.2)
  const events = [ev({ macro_direction: 'risk_on', market_impact_tier: 2, confidence: 0.55 })];
  const score = aggregateRegime({ events, now: NOW }).riskScore;
  assert.ok(score > 0.2 && score < 0.3, `测试前提:分数 ${score} 落在滞回带内`);
  // 之前是 neutral:不足以进入 risk_on
  assert.equal(aggregateRegime({ events, now: NOW, prev: { regime: 'neutral' } }).regime, 'neutral');
  // 之前已是 risk_on:维持
  assert.equal(aggregateRegime({ events, now: NOW, prev: { regime: 'risk_on' } }).regime, 'risk_on');
});

test('aggregateRegime:子标签聚合(利率/通胀/增长)', () => {
  const events = [
    ev({
      macro_direction: 'neutral',
      rates_signal: 'hawkish',
      inflation_signal: 'up',
      growth_signal: 'down',
      confidence: 0.9,
    }),
  ];
  const r = aggregateRegime({ events, now: NOW });
  assert.equal(r.rates, 'hawkish');
  assert.equal(r.inflation, 'up');
  assert.equal(r.growth, 'down');
});

test('aggregateRegime:同类型同方向重复事件组内衰减,不线性叠加', () => {
  const dup = ev({ event_type: 'geopolitics', market_impact_tier: 2, confidence: 0.8 });
  const single = aggregateRegime({ events: [dup], now: NOW }).riskScore;
  const tripled = aggregateRegime({ events: [dup, { ...dup }, { ...dup }], now: NOW }).riskScore;
  // 理论线性叠加值:3 份全权重(无衰减时的分数)
  const w = 0.6 * 0.8 * Math.exp(-0.5 / 24);
  const linear = -Math.min((3 * w) / (3 * w + 1), 1);
  assert.ok(Math.abs(tripled) > Math.abs(single), '重复事件仍应比单条略强(算一次+小幅增量)');
  assert.ok(Math.abs(tripled) < Math.abs(linear) - 0.01, `${tripled} 应显著弱于线性叠加 ${linear}`);
});

test('aggregateRegime:不同类型同方向事件不衰减(多事件同向是真实信号)', () => {
  const a = ev({ event_type: 'geopolitics', market_impact_tier: 2, confidence: 0.8 });
  const sameType = aggregateRegime({ events: [a, { ...a }], now: NOW }).riskScore;
  const crossType = aggregateRegime({
    events: [a, { ...a, event_type: 'CPI' }],
    now: NOW,
  }).riskScore;
  assert.ok(Math.abs(crossType) > Math.abs(sameType), '跨类型两事件应强于同类型两条重复');
});

test('aggregateRegime:同类型不同方向各自全权重,互相抵消为 0', () => {
  const events = [
    ev({ event_type: 'FOMC', market_impact_tier: 2, confidence: 0.8 }),
    ev({ event_type: 'FOMC', market_impact_tier: 2, confidence: 0.8, macro_direction: 'risk_on' }),
  ];
  assert.equal(aggregateRegime({ events, now: NOW }).riskScore, 0);
});

test('mergeMacroConfidence:较大值小幅增信,封顶 0.95,非法值兜底', () => {
  assert.equal(mergeMacroConfidence(0.7, 0.9), Number((0.9 * 1.05).toFixed(3)));
  assert.equal(mergeMacroConfidence(0.8, 0.8), 0.84);
  assert.equal(mergeMacroConfidence(0.95, 0.95), 0.95, '绝对封顶 0.95');
  assert.equal(mergeMacroConfidence(null, NaN), Number((0.5 * 1.05).toFixed(3)), '非法值兜底 0.5');
});

test('sectorMultiplier:利好放大/利空压缩,clamp 区间,无命中为 1', () => {
  const bearish = [
    ev({ affected_sectors: [{ sector: 'Technology', direction: 'bearish' }], confidence: 0.95 }),
  ];
  const mult = sectorMultiplier('Technology', bearish, NOW);
  assert.ok(mult < 1 && mult >= 0.6, `利空行业乘数 ${mult} 应在 [0.6, 1)`);
  const bullish = [
    ev({
      macro_direction: 'risk_on',
      affected_sectors: [{ sector: 'Energy', direction: 'bullish' }],
      confidence: 0.95,
    }),
  ];
  const up = sectorMultiplier('Energy', bullish, NOW);
  assert.ok(up > 1 && up <= 1.2, `利好行业乘数 ${up} 应在 (1, 1.2]`);
  assert.equal(sectorMultiplier('Healthcare', bearish, NOW), 1, '未命中行业为 1');
  assert.equal(sectorMultiplier(null, bearish, NOW), 1, '无行业为 1');
});
