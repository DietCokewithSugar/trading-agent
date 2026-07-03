import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCandidateFields } from '../server/services/candidateStore.js';

const NOW = new Date('2026-07-03T16:39:00Z');

test('mergeCandidateFields:新信号更强时刷新信号字段并续命', () => {
  const existing = {
    id: 7,
    symbol: 'TSLA',
    base_score: 0.574,
    merged_events: 1,
    status: 'pending',
    entry_price: 394.4,
    created_at: '2026-07-03T16:37:00Z',
  };
  const incoming = {
    news_id: 11,
    analysis_id: 22,
    event_id: 33,
    tier: 1,
    confidence: 0.9,
    final_confidence: 0.8,
    source_score: 0.95,
    sector: 'Technology',
    base_score: 0.807,
  };
  const fields = mergeCandidateFields(existing, incoming, { now: NOW, maxAgeHours: 24 });
  assert.equal(fields.base_score, 0.807, '取更强的新基础分');
  assert.equal(fields.current_score, 0.807, '当前分先取新基础分,下一分配轮重刷');
  assert.equal(fields.analysis_id, 22);
  assert.equal(fields.event_id, 33);
  assert.equal(fields.tier, 1);
  assert.equal(fields.sector, 'Technology');
  assert.equal(fields.merged_events, 2, '事件计数 +1');
  assert.equal(fields.last_signal_at, NOW.toISOString(), '时效锚点取最新事件时刻');
  assert.equal(
    fields.expires_at,
    new Date(NOW.getTime() + 24 * 3600_000).toISOString(),
    '过期时钟按最新信号续命'
  );
  // 状态/入池锚点/分桶口径永不动
  for (const key of ['status', 'status_reason', 'entry_price', 'created_at', 'macro_regime', 'trade_id']) {
    assert.ok(!(key in fields), `${key} 不应出现在合并字段中`);
  }
});

test('mergeCandidateFields:新信号更弱时只续命不刷信号字段', () => {
  const fields = mergeCandidateFields(
    { base_score: 0.807, merged_events: 2 },
    { base_score: 0.574, analysis_id: 99, tier: 2 },
    { now: NOW, maxAgeHours: 24 }
  );
  assert.deepEqual(Object.keys(fields).sort(), ['expires_at', 'last_signal_at', 'merged_events']);
  assert.equal(fields.merged_events, 3);
});

test('mergeCandidateFields:分数相等按不更强处理,旧行缺 merged_events 按 1 计', () => {
  const equal = mergeCandidateFields(
    { base_score: 0.6 },
    { base_score: 0.6, analysis_id: 5 },
    { now: NOW }
  );
  assert.ok(!('base_score' in equal), '相等不刷新');
  assert.equal(equal.merged_events, 2, '缺失 merged_events 的旧行按 1 计');
});
