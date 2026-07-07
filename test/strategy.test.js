import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STRATEGIES,
  isEntryPathStrategy,
  strategyBracket,
  strategyMaxHoldHours,
} from '../server/services/strategy.js';

const cfg = {
  stopLossPercent: 2,
  takeProfitPercent: 2,
  shadowWideBracketPercent: 4,
  maxHoldHours: 48,
  strategyMaxHoldHours: { wide_bracket: 96 },
};

test('STRATEGIES 预设清单与入场路径类判定', () => {
  assert.deepEqual(STRATEGIES, [
    'default',
    'wide_bracket',
    'trailing_only',
    'vol_bracket',
    'immediate_trade',
    'immediate_rotation',
    'equal_weight',
  ]);
  assert.equal(isEntryPathStrategy('immediate_trade'), true);
  assert.equal(isEntryPathStrategy('immediate_rotation'), true);
  assert.equal(isEntryPathStrategy('equal_weight'), true);
  assert.equal(isEntryPathStrategy('default'), false);
  assert.equal(isEntryPathStrategy('wide_bracket'), false);
  assert.equal(isEntryPathStrategy('vol_bracket'), false);
});

test('strategyBracket:各策略的止损止盈宽度', () => {
  // 默认与入场类:固定 ±2
  for (const s of ['default', 'immediate_trade', 'immediate_rotation', 'equal_weight']) {
    assert.deepEqual(strategyBracket(s, { cfg }), { stopLossPercent: 2, takeProfitPercent: 2 }, s);
  }
  // 宽敞口 ±4
  assert.deepEqual(strategyBracket('wide_bracket', { cfg }), { stopLossPercent: 4, takeProfitPercent: 4 });
  // 仅移动止损:止损同距、不设止盈
  assert.deepEqual(strategyBracket('trailing_only', { cfg }), { stopLossPercent: 2, takeProfitPercent: null });
  // 波动自适应:有波动用对称宽度,波动不可算回退固定值
  assert.deepEqual(
    strategyBracket('vol_bracket', { volBracketPercent: 3.2, cfg }),
    { stopLossPercent: 3.2, takeProfitPercent: 3.2 }
  );
  assert.deepEqual(
    strategyBracket('vol_bracket', { volBracketPercent: null, cfg }),
    { stopLossPercent: 2, takeProfitPercent: 2 }
  );
});

test('strategyMaxHoldHours:wide_bracket 96h,其余沿用全局', () => {
  assert.equal(strategyMaxHoldHours('wide_bracket', cfg), 96);
  assert.equal(strategyMaxHoldHours('default', cfg), 48);
  assert.equal(strategyMaxHoldHours('trailing_only', cfg), 48);
  assert.equal(strategyMaxHoldHours('immediate_rotation', cfg), 48);
  // 全局关闭(0)时同样透传
  assert.equal(strategyMaxHoldHours('default', { ...cfg, maxHoldHours: 0 }), 0);
});
