import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashMessages,
  stripReplay,
  beginDecisionEpisode,
  attachOfficer,
} from '../server/services/decisionLog.js';

const messages = [
  { role: 'system', content: '系统提示' },
  { role: 'user', content: '{"新闻标题":"测试"}' },
];

test('hashMessages:确定性,内容变化即变化', () => {
  assert.equal(hashMessages(messages), hashMessages([...messages]));
  assert.notEqual(
    hashMessages(messages),
    hashMessages([messages[0], { role: 'user', content: '{"新闻标题":"测试2"}' }])
  );
  assert.equal(hashMessages(null).length, 64, '空输入也产生合法 sha256');
});

test('stripReplay:剥离 replay 附件,其余字段保留', () => {
  const decision = { action: 'buy', fraction: 0.1, replay: { messages, raw: {} } };
  assert.deepEqual(stripReplay(decision), { action: 'buy', fraction: 0.1 });
  assert.equal(stripReplay(null), null);
});

test('beginDecisionEpisode:从 decision.replay 提取回放字段并快照 sizing 起点', () => {
  const decision = {
    symbolValid: true,
    action: 'buy',
    fraction: 0.12,
    reason: '测试',
    replay: { promptVersion: 1, messages, raw: { action: 'buy', fraction: 0.3 }, latencyMs: 1234 },
  };
  const episode = beginDecisionEpisode({
    path: 'allocation',
    symbol: 'AAPL',
    article: { id: 7 },
    analysisRow: { id: 8 },
    candidateId: 9,
    decisionPrice: 123.45,
    decision,
    runId: 'run-1',
  });
  assert.equal(episode.symbol, 'AAPL');
  assert.equal(episode.path, 'allocation');
  assert.equal(episode.news_id, 7);
  assert.equal(episode.analysis_id, 8);
  assert.equal(episode.candidate_id, 9);
  assert.equal(episode.trader_prompt_version, 1);
  assert.equal(episode.trader_input_hash, hashMessages(messages));
  assert.deepEqual(episode.trader_raw, { action: 'buy', fraction: 0.3 });
  assert.equal(episode.trader_decision.replay, undefined, 'normalized 快照不含 replay');
  assert.equal(episode.trader_decision.fraction, 0.12);
  assert.equal(episode.trader_latency_ms, 1234);
  assert.equal(episode.decision_price, 123.45);
  assert.deepEqual(episode.sizing, { llm_fraction: 0.12 });
});

test('beginDecisionEpisode:decision 无 replay(异常路径)时回放字段为 null', () => {
  const episode = beginDecisionEpisode({
    path: 'immediate',
    symbol: 'MSFT',
    decision: { action: 'hold', fraction: 0 },
  });
  assert.equal(episode.trader_messages, null);
  assert.equal(episode.trader_input_hash, null);
  assert.equal(episode.trader_prompt_version, null);
});

test('attachOfficer:填充风控官回放字段', () => {
  const episode = beginDecisionEpisode({
    path: 'immediate',
    symbol: 'NVDA',
    decision: { action: 'buy', fraction: 0.1, replay: { promptVersion: 1, messages, raw: {} } },
  });
  const verdict = {
    approve: true,
    scale: 0.5,
    reason: '行业集中度偏高',
    replay: { promptVersion: 1, messages, raw: { approve: true, scale: 0.5 }, latencyMs: 800 },
  };
  attachOfficer(episode, verdict);
  assert.equal(episode.officer_prompt_version, 1);
  assert.equal(episode.officer_input_hash, hashMessages(messages));
  assert.equal(episode.officer_verdict.replay, undefined);
  assert.equal(episode.officer_verdict.scale, 0.5);
  assert.equal(episode.officer_latency_ms, 800);
});
