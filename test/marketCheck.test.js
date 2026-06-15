import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, classifyMarketTrend, intersectRegime } from '../server/services/marketCheck.js';

test('sma:末尾 n 个值的均值,样本不足为 null', () => {
  assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  assert.equal(sma([1, 2, 3], 3), 2);
  assert.equal(sma([1, 2], 3), null, '样本不足');
  assert.equal(sma([], 1), null);
  assert.equal(sma([1, 'x', 3], 2), 2, '非数值被过滤');
});

test('classifyMarketTrend:SPY 趋势 × VIX 四象分类', () => {
  const cfg = { smaBufferPercent: 0.5, vixRiskOnMax: 20, vixRiskOffMin: 26 };
  // 站上均线 + 低 VIX → risk_on
  assert.equal(classifyMarketTrend({ spyPrice: 101, sma20: 100, vix: 15, cfg }), 'risk_on');
  // 站上均线但 VIX 高企 → 不是 risk_on(30 ≥ 26 → risk_off)
  assert.equal(classifyMarketTrend({ spyPrice: 101, sma20: 100, vix: 30, cfg }), 'risk_off');
  // 站上均线、VIX 居中(20~26)→ neutral
  assert.equal(classifyMarketTrend({ spyPrice: 101, sma20: 100, vix: 22, cfg }), 'neutral');
  // 跌破缓冲带下沿 → risk_off(VIX 再低也不放行)
  assert.equal(classifyMarketTrend({ spyPrice: 99, sma20: 100, vix: 12, cfg }), 'risk_off');
  // 缓冲带内 → neutral(贴着均线不翻转)
  assert.equal(classifyMarketTrend({ spyPrice: 100.2, sma20: 100, vix: 15, cfg }), 'neutral');
  // VIX 缺失:退化为仅 SPY 趋势
  assert.equal(classifyMarketTrend({ spyPrice: 101, sma20: 100, vix: null, cfg }), 'risk_on');
  assert.equal(classifyMarketTrend({ spyPrice: 99, sma20: 100, vix: null, cfg }), 'risk_off');
  // 输入不足 → null(核验不可用)
  assert.equal(classifyMarketTrend({ spyPrice: null, sma20: 100, cfg }), null);
  assert.equal(classifyMarketTrend({ spyPrice: 100, sma20: 0, cfg }), null);
});

test('intersectRegime:钳制 risk_on 放大;市场看多绝不放松避险', () => {
  const onCheck = { available: true, trend: 'risk_on' };
  const neutralCheck = { available: true, trend: 'neutral' };
  const unavailable = { available: false, trend: null };
  const F = { clamped: false, marketStress: false, confirmed: false };
  // 新闻 risk_on:核验同向才放行
  assert.deepEqual(intersectRegime('risk_on', onCheck), { regime: 'risk_on', ...F });
  assert.deepEqual(intersectRegime('risk_on', neutralCheck), { regime: 'neutral', ...F, clamped: true });
  // 核验不可用:完全透传(fail-open)
  assert.deepEqual(intersectRegime('risk_on', unavailable), { regime: 'risk_on', ...F });
  assert.deepEqual(intersectRegime('risk_on', null), { regime: 'risk_on', ...F });
  // 市场看多:既有的 neutral/risk_off 原样通过,绝不放松
  assert.deepEqual(intersectRegime('risk_off', onCheck), { regime: 'risk_off', ...F });
  assert.deepEqual(intersectRegime('macro_shock', onCheck), { regime: 'macro_shock', ...F });
  assert.deepEqual(intersectRegime('neutral', onCheck), { regime: 'neutral', ...F });
});

test('intersectRegime:市场避险只收紧——抬到 risk_off 参数(market_stress),且对 risk_on 同时钳制', () => {
  const offCheck = { available: true, trend: 'risk_off' };
  const F = { clamped: false, marketStress: false, confirmed: false };
  // 情况 D:新闻只是 neutral,但 SPY 跌破/VIX 恐慌 → 执行参数收紧至 risk_off
  assert.deepEqual(intersectRegime('neutral', offCheck), { regime: 'risk_off', ...F, marketStress: true });
  // 新闻 risk_on + 市场避险:先钳制放大,再因市场压力收紧到 risk_off
  assert.deepEqual(intersectRegime('risk_on', offCheck), {
    regime: 'risk_off',
    clamped: true,
    marketStress: true,
    confirmed: false,
  });
});

test('intersectRegime:新闻避险 + 市场同向 → confirmed(印证),不重复收紧也不算 stress', () => {
  const offCheck = { available: true, trend: 'risk_off' };
  // 新闻已 risk_off,市场同向:印证,参数仍 risk_off(未被抬高,不算 market_stress)
  assert.deepEqual(intersectRegime('risk_off', offCheck), {
    regime: 'risk_off',
    clamped: false,
    marketStress: false,
    confirmed: true,
  });
  // macro_shock + 市场避险:已最紧,仅标记印证
  assert.deepEqual(intersectRegime('macro_shock', offCheck), {
    regime: 'macro_shock',
    clamped: false,
    marketStress: false,
    confirmed: true,
  });
  // macro_shock + 市场不可用:不印证(无核验)
  assert.deepEqual(intersectRegime('macro_shock', { available: false, trend: null }), {
    regime: 'macro_shock',
    clamped: false,
    marketStress: false,
    confirmed: false,
  });
});
