import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFill } from '../server/services/execution.js';

// 默认配置:ENABLE_SLIPPAGE=true, SLIPPAGE_MAX_BPS=150, COMMISSION_BPS=0

test('盘中超大盘:半点差 1bp + 微小冲击,买入价高于参考价', () => {
  const quote = { price: 100, effective_price: 100, session: 'regular', changesPercentage: 0 };
  const profile = { marketCap: 300e9, averageVolume: 1e7 };
  const { fillPrice, slippageBps, refPrice } = computeFill({
    side: 'buy',
    quote,
    profile,
    notional: 10_000,
  });
  assert.equal(refPrice, 100);
  // 1bp × 1 × 1 + 冲击(10000/1e9 × 10000 × 0.1 = 0.01bp)= 1.01bp
  assert.equal(slippageBps, 1.01);
  assert.ok(fillPrice > refPrice, '买入滑点必须不利(更贵)');
});

test('卖出滑点方向相反(更便宜)', () => {
  const quote = { price: 50, effective_price: 50, session: 'regular', changesPercentage: 0 };
  const profile = { marketCap: 300e9, averageVolume: 1e7 };
  const { fillPrice } = computeFill({ side: 'sell', quote, profile, notional: 1_000 });
  assert.ok(fillPrice < 50);
});

test('盘前盘后时段乘数 ×3', () => {
  const quote = { price: 100, effective_price: 100, session: 'pre', changesPercentage: 0 };
  const profile = { marketCap: 300e9, averageVolume: 1e9 };
  const { slippageBps } = computeFill({ side: 'buy', quote, profile, notional: 100 });
  // 半点差 1bp × pre 3 ≈ 3bp(冲击可忽略)
  assert.ok(Math.abs(slippageBps - 3) < 0.1);
});

test('微盘 + 休市 + 高波动:滑点封顶 SLIPPAGE_MAX_BPS', () => {
  // 未知市值按微盘 30bp,closed ×4,涨跌 10% 波动乘数 ×2 → 240bp,封顶 150
  const quote = { price: 5, effective_price: 5, session: 'closed', changesPercentage: 10 };
  const { slippageBps, fillPrice } = computeFill({
    side: 'buy',
    quote,
    profile: null,
    notional: 1_000,
  });
  assert.equal(slippageBps, 150);
  assert.equal(fillPrice, 5.075); // 5 × (1 + 150bp)
});

test('订单冲击随订单金额线性增长', () => {
  const quote = { price: 10, effective_price: 10, session: 'regular', changesPercentage: 0 };
  const profile = { marketCap: 5e9, averageVolume: 1e6 }; // 中盘,日均成交额 $10M
  const small = computeFill({ side: 'buy', quote, profile, notional: 10_000 });
  const big = computeFill({ side: 'buy', quote, profile, notional: 100_000 });
  assert.ok(big.slippageBps > small.slippageBps);
  // 占日均成交额 1% 的冲击 ≈ 10bp:100k/10M = 1% → 10bp 冲击 + 5bp 半点差(中盘)
  assert.equal(big.slippageBps, 15);
});
