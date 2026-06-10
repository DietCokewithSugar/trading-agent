import test from 'node:test';
import assert from 'node:assert/strict';

// node --test 对每个测试文件独立起进程:在 import config 之前关掉滑点开关
process.env.ENABLE_SLIPPAGE = 'false';
const { computeFill } = await import('../server/services/execution.js');

test('ENABLE_SLIPPAGE=false 时按参考价原价成交', () => {
  const quote = { price: 123.456, effective_price: 123.456, session: 'closed', changesPercentage: 9 };
  const { fillPrice, slippageBps, refPrice } = computeFill({
    side: 'buy',
    quote,
    profile: null,
    notional: 50_000,
  });
  assert.equal(slippageBps, 0);
  assert.equal(fillPrice, 123.456);
  assert.equal(refPrice, 123.456);
});
