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

test('intersectRegime:只钳制 risk_on 放大,避险方向永不放松', () => {
  const onCheck = { available: true, trend: 'risk_on' };
  const offCheck = { available: true, trend: 'risk_off' };
  const neutralCheck = { available: true, trend: 'neutral' };
  const unavailable = { available: false, trend: null };
  // 新闻 risk_on:核验同向才放行
  assert.deepEqual(intersectRegime('risk_on', onCheck), { regime: 'risk_on', clamped: false });
  assert.deepEqual(intersectRegime('risk_on', neutralCheck), { regime: 'neutral', clamped: true });
  assert.deepEqual(intersectRegime('risk_on', offCheck), { regime: 'neutral', clamped: true });
  // 核验不可用:完全透传(fail-open)
  assert.deepEqual(intersectRegime('risk_on', unavailable), { regime: 'risk_on', clamped: false });
  assert.deepEqual(intersectRegime('risk_on', null), { regime: 'risk_on', clamped: false });
  // 避险/冲击/中性原样通过——即使核验看多也不放松
  assert.deepEqual(intersectRegime('risk_off', onCheck), { regime: 'risk_off', clamped: false });
  assert.deepEqual(intersectRegime('macro_shock', onCheck), { regime: 'macro_shock', clamped: false });
  assert.deepEqual(intersectRegime('neutral', onCheck), { regime: 'neutral', clamped: false });
});
