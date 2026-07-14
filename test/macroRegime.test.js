import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateRegime,
  aggregateRegimeSeries,
  sectorMultiplier,
  mergeMacroConfidence,
  eventWeight,
  shockCorroborated,
} from '../server/services/macroRegime.js';

const NOW = new Date('2026-06-11T15:00:00Z');

function ev(overrides = {}) {
  return {
    market_impact_tier: 1,
    macro_direction: 'risk_off',
    confidence: 0.9,
    source_score: 1, // 016 来源分;置 1 保持本文件既有数值断言不变
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

test('macro_shock 佐证门:单篇单源不触发,多篇或多独立信源触发', () => {
  // 单篇单源:不触发(措辞激烈的单篇评论文不能独自冻结全部买入)
  const lone = ev({ article_count: 1, source_domains: ['blog.example.com'] });
  assert.notEqual(aggregateRegime({ events: [lone], now: NOW }).regime, 'macro_shock');
  // 归并报道 ≥2 篇:触发
  const corroborated = ev({ article_count: 2, source_domains: ['blog.example.com'] });
  assert.equal(aggregateRegime({ events: [corroborated], now: NOW }).regime, 'macro_shock');
  // 独立信源 ≥2 个:触发
  const twoSources = ev({ article_count: 1, source_domains: ['reuters.com', 'cnbc.com'] });
  assert.equal(aggregateRegime({ events: [twoSources], now: NOW }).regime, 'macro_shock');
  // shockMinReports=1:恢复单篇即触发的旧行为
  assert.equal(
    aggregateRegime({ events: [lone], now: NOW, cfg: { shockMinReports: 1 } }).regime,
    'macro_shock'
  );
});

test('macro_shock 佐证门:015/016 之前的存量行(无佐证字段)回退单篇即触发', () => {
  // ev() 不带 article_count/source_domains,模拟迁移前的行——安全线不静默失效
  const legacy = ev();
  assert.equal(shockCorroborated(legacy, 2), true);
  assert.equal(aggregateRegime({ events: [legacy], now: NOW }).regime, 'macro_shock');
  // 只有 015(article_count)没有 016(source_domains):按篇数判定
  assert.equal(shockCorroborated(ev({ article_count: 1 }), 2), false);
  assert.equal(shockCorroborated(ev({ article_count: 3 }), 2), true);
  // 重复域名不算独立信源
  assert.equal(shockCorroborated(ev({ article_count: 1, source_domains: ['a.com', 'a.com'] }), 2), false);
});

test('eventWeight:来源可信度乘入权重,缺失按 0.7,clamp 下限 0.4', () => {
  const nowTs = NOW.getTime();
  const base = ev({ source_score: 1 });
  const low = ev({ source_score: 0.5 });
  const floor = ev({ source_score: 0.1 });
  const missing = ev();
  delete missing.source_score;
  const wBase = eventWeight(base, nowTs, 24);
  assert.ok(Math.abs(eventWeight(low, nowTs, 24) - wBase * 0.5) < 1e-9, '低来源分线性削弱权重');
  assert.ok(Math.abs(eventWeight(floor, nowTs, 24) - wBase * 0.4) < 1e-9, '下限 0.4');
  assert.ok(Math.abs(eventWeight(missing, nowTs, 24) - wBase * 0.7) < 1e-9, '缺失按 0.7');
  // 端到端:低来源分事件推出的风险分应弱于高来源分同款事件
  const strong = aggregateRegime({ events: [ev({ market_impact_tier: 2 })], now: NOW }).riskScore;
  const weak = aggregateRegime({
    events: [ev({ market_impact_tier: 2, source_score: 0.5 })],
    now: NOW,
  }).riskScore;
  assert.ok(Math.abs(weak) < Math.abs(strong), '小站标题党与路透社不该同权');
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

// ── 按日回溯序列(宏观页历史热力图)──

function seriesDays(keys) {
  return keys.map((date) => ({
    date,
    startTs: Date.parse(`${date}T00:00:00Z`),
    endTs: Date.parse(`${date}T00:00:00Z`) + 24 * 3600_000,
  }));
}

test('aggregateRegimeSeries:空事件/空日序列 → 逐日 neutral、0 分、0 事件', () => {
  assert.deepEqual(aggregateRegimeSeries({ events: [], days: [] }), []);
  const series = aggregateRegimeSeries({ events: [], days: seriesDays(['2026-06-01']) });
  assert.equal(series.length, 1);
  assert.equal(series[0].date, '2026-06-01');
  assert.equal(series[0].regime, 'neutral');
  assert.equal(series[0].risk_score, 0);
  assert.equal(series[0].events, 0);
});

test('aggregateRegimeSeries:滞回链式传递——次日衰减到进入阈以下、退出阈以上时维持原状态', () => {
  // 事件在 6/1 深夜:当日收盘视角分数 ≈0.46(≥0.30 进入 risk_on);
  // 次日收盘衰减到 ≈0.24 ∈ (0.20, 0.30):无状态重算会回 neutral,链式 prev 应维持 risk_on;
  // 第三日 ≈0.10 < 0.20,退出为 neutral
  const events = [
    ev({ macro_direction: 'risk_on', created_at: '2026-06-01T23:00:00Z', confidence: 0.9 }),
  ];
  const days = seriesDays(['2026-06-01', '2026-06-02', '2026-06-03']);
  const series = aggregateRegimeSeries({ events, days });
  assert.equal(series[0].regime, 'risk_on');
  assert.equal(series[0].events, 1);
  assert.equal(series[1].regime, 'risk_on', '滞回:退出阈以上维持原状态');
  assert.equal(series[1].events, 0, '事件数只计当日新增');
  assert.ok(series[1].risk_score < series[0].risk_score, '风险分随时间衰减');
  // 对照:同一时点无状态重算(prev=null)会掉回 neutral,证明链式传递生效
  const stateless = aggregateRegime({ events, now: days[1].endTs - 1, prev: null });
  assert.equal(stateless.regime, 'neutral');
  assert.equal(series[2].regime, 'neutral', '衰减穿过退出阈后回中性');
});

test('aggregateRegimeSeries:shock 只锁定事件所在日,风险分与后续日不受 prev 污染', () => {
  // 一档高置信 risk_off(存量行无佐证字段 → 单篇即触发):事件日为 macro_shock,
  // 次日 shockUntil 已过期 → 按分数判定
  const events = [ev({ created_at: '2026-06-01T20:00:00Z', confidence: 0.9 })];
  const days = seriesDays(['2026-06-01', '2026-06-02']);
  const series = aggregateRegimeSeries({ events, days });
  assert.equal(series[0].regime, 'macro_shock');
  assert.notEqual(series[1].regime, 'macro_shock', 'shock 到期不跨日延续');
  assert.ok(series[1].risk_score < 0, 'risk_off 事件仍在有效期内,分数为负');
});
