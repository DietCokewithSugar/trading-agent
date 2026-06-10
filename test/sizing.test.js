import test from 'node:test';
import assert from 'node:assert/strict';
import { scaleFraction } from '../server/services/sizing.js';

test('一档 + 满置信度 + 权威来源:不缩放', () => {
  const { sized } = scaleFraction({ fraction: 0.2, tier: 1, confidence: 1, sourceScore: 1 });
  assert.equal(sized, 0.2);
});

test('二档七折、三/四档对半', () => {
  assert.equal(scaleFraction({ fraction: 0.2, tier: 2, confidence: 1, sourceScore: 1 }).sized, 0.14);
  assert.equal(scaleFraction({ fraction: 0.2, tier: 3, confidence: 1, sourceScore: 1 }).sized, 0.1);
  assert.equal(scaleFraction({ fraction: 0.2, tier: 4, confidence: 1, sourceScore: 1 }).sized, 0.1);
});

test('置信度映射 0.5~1.0 → ×0.5~×1,缺失按 ×0.7', () => {
  assert.equal(scaleFraction({ fraction: 0.2, tier: 1, confidence: 0.5, sourceScore: 1 }).sized, 0.1);
  // 低于 0.5 的置信度按 0.5 兜底(本不应到达交易环节)
  assert.equal(scaleFraction({ fraction: 0.2, tier: 1, confidence: 0.2, sourceScore: 1 }).sized, 0.1);
  assert.equal(scaleFraction({ fraction: 0.2, tier: 1, confidence: null, sourceScore: 1 }).sized, 0.14);
});

test('来源可信度映射 ×0.6~×1,无评分(旧库)不缩放', () => {
  // 0.5 + 0.5×0.95 = 0.975
  assert.equal(
    scaleFraction({ fraction: 0.2, tier: 1, confidence: 1, sourceScore: 0.95 }).sized,
    0.195
  );
  // 极低分来源:下限 0.6
  assert.equal(scaleFraction({ fraction: 0.2, tier: 1, confidence: 1, sourceScore: 0.1 }).sized, 0.12);
  assert.equal(scaleFraction({ fraction: 0.2, tier: 1, confidence: 1, sourceScore: null }).sized, 0.2);
});

test('三因子叠乘', () => {
  // 0.5 × 0.7(二档)× 0.6(置信度0.6)× 0.75(来源0.5)= 0.1575
  const { sized } = scaleFraction({ fraction: 0.5, tier: 2, confidence: 0.6, sourceScore: 0.5 });
  assert.equal(sized, 0.1575);
});
