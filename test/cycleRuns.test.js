import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRejectReasons } from '../server/services/cycleRuns.js';

test('aggregateRejectReasons:合并多轮拒绝原因计数', () => {
  const runs = [
    { reject_reasons: { event_dedup: 3, llm_hold: 1 } },
    { reject_reasons: { event_dedup: 2, price_drift_abort: 1 } },
    { reject_reasons: {} },
  ];
  assert.deepEqual(aggregateRejectReasons(runs), {
    event_dedup: 5,
    llm_hold: 1,
    price_drift_abort: 1,
  });
});

test('aggregateRejectReasons:容忍空数组与非法行', () => {
  assert.deepEqual(aggregateRejectReasons([]), {});
  assert.deepEqual(aggregateRejectReasons(null), {});
  assert.deepEqual(
    aggregateRejectReasons([
      { reject_reasons: null },
      { reject_reasons: 'bad' },
      { reject_reasons: ['array'] },
      {},
      null,
      { reject_reasons: { ok: 1, bad: 'x', negative: -2 } },
    ]),
    { ok: 1 }
  );
});
