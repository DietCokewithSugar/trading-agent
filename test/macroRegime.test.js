import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateRegime,
  sectorMultiplier,
  mergeMacroConfidence,
  eventWeight,
  shockCorroborated,
  factContributions,
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

test('eventWeight:意外幅度乘数(surprise_score)放大/压缩权重,缺失为 1,clamp [0.5,1.5]', () => {
  const nowTs = NOW.getTime();
  const base = ev();
  const big = ev({ surprise_score: 1.5 });
  const small = ev({ surprise_score: 0.5 });
  const wild = ev({ surprise_score: 9 }); // 异常值被钳到 1.5
  const wBase = eventWeight(base, nowTs, 24);
  assert.ok(Math.abs(eventWeight(big, nowTs, 24) - wBase * 1.5) < 1e-9, '显著超预期权重 ×1.5');
  assert.ok(Math.abs(eventWeight(small, nowTs, 24) - wBase * 0.5) < 1e-9, '符合预期权重 ×0.5');
  assert.ok(Math.abs(eventWeight(wild, nowTs, 24) - wBase * 1.5) < 1e-9, '上限 1.5');
});

test('shockCorroborated:经济日历实际值(has_actual)自身即硬证据,直接放行', () => {
  // 日历独建事实:无新闻报道(source_count 0)也算佐证
  const calendarFact = { has_actual: true, source_count: 0, source_domains: [] };
  assert.equal(shockCorroborated(calendarFact, 2), true);
  // source_count 与 article_count 同义
  assert.equal(shockCorroborated({ source_count: 2, source_domains: [] }, 2), true);
  assert.equal(shockCorroborated({ source_count: 1, source_domains: [] }, 2), false);
});

test('aggregateRegime:日历独建的一档高置信 risk_off 事实(has_actual)触发 macro_shock', () => {
  const calendarFact = ev({ has_actual: true, source_count: 0, source_domains: [] });
  delete calendarFact.article_count;
  assert.equal(aggregateRegime({ events: [calendarFact], now: NOW }).regime, 'macro_shock');
});

test('factContributions:各项之和≈riskScore,方向符号正确,按绝对值降序', () => {
  const events = [
    ev({ event_type: 'CPI', macro_direction: 'risk_off', market_impact_tier: 1, confidence: 0.9, id: 1, event_key: 'CPI_2026-06' }),
    ev({ event_type: 'energy', macro_direction: 'risk_on', market_impact_tier: 3, confidence: 0.6, id: 2, event_key: 'energy_x' }),
  ];
  const score = aggregateRegime({ events, now: NOW }).riskScore;
  const contribs = factContributions(events, NOW);
  const sum = contribs.reduce((a, c) => a + c.contribution, 0);
  assert.ok(Math.abs(sum - score) < 0.01, `贡献之和 ${sum} ≈ riskScore ${score}`);
  // risk_off 贡献为负、risk_on 为正
  const cpi = contribs.find((c) => c.id === 1);
  const energy = contribs.find((c) => c.id === 2);
  assert.ok(cpi.contribution < 0, 'risk_off 贡献为负');
  assert.ok(energy.contribution > 0, 'risk_on 贡献为正');
  assert.equal(cpi.event_key, 'CPI_2026-06');
  // 按绝对贡献降序:一档 CPI 应排在三档 energy 之前
  assert.ok(Math.abs(contribs[0].contribution) >= Math.abs(contribs[1].contribution));
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
