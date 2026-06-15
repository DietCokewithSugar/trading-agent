import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText,
  tokenSet,
  jaccardSimilarity,
  isNearDuplicate,
  findDuplicateEvent,
  clusterAnalyses,
} from '../server/services/newsDedup.js';

test('normalizeText 转小写、去标点、压缩空白', () => {
  assert.equal(normalizeText('  Hello, WORLD!!  Foo-Bar  '), 'hello world foo bar');
  assert.equal(normalizeText(null), '');
});

test('tokenSet 去停用词', () => {
  const s = tokenSet('The Apple and the Orange Inc');
  assert.ok(s.has('apple'));
  assert.ok(s.has('orange'));
  assert.ok(!s.has('the'));
  assert.ok(!s.has('and'));
  assert.ok(!s.has('inc'));
});

test('jaccardSimilarity 相同文本为 1,完全不同为 0', () => {
  assert.equal(jaccardSimilarity('Apple beats earnings', 'Apple beats earnings'), 1);
  assert.equal(jaccardSimilarity('apple earnings', 'tesla recall lawsuit'), 0);
  assert.equal(jaccardSimilarity('', 'anything'), 0);
});

test('isNearDuplicate 识别一字不差的新闻稿重复', () => {
  const a = {
    title:
      'ROSEN, LEADING TRIAL ATTORNEYS, Encourages BitGo Holdings, Inc. Investors to Secure Counsel Before Important Deadline in Securities Class Action - BTGO',
  };
  const b = {
    title:
      'ROSEN, LEADING TRIAL ATTORNEYS, Encourages BitGo Holdings, Inc. Investors to Secure Counsel Before Important Deadline in Securities Class Action - BTGO',
  };
  assert.equal(isNearDuplicate(a, b, 0.8), true);
});

test('isNearDuplicate 不把不同事件误判为重复', () => {
  const a = { title: 'Apple unveils new iPhone with AI features' };
  const b = { title: 'Tesla recalls 50000 vehicles over brake defect' };
  assert.equal(isNearDuplicate(a, b, 0.8), false);
});

test('findDuplicateEvent 命中同方向最相似事件,跳过反方向', () => {
  const incoming = {
    title: 'BitGo Holdings securities class action deadline approaching',
    summary: 'BitGo 证券集体诉讼,投资者截止日临近',
    sentiment: 'bearish',
  };
  const events = [
    { id: 1, summary: 'Apple 发布新品', sentiment: 'bullish' },
    { id: 2, summary: 'BitGo 证券集体诉讼,投资者截止日临近', sentiment: 'bearish' },
    { id: 3, summary: 'BitGo 证券集体诉讼,投资者截止日临近', sentiment: 'bullish' },
  ];
  const hit = findDuplicateEvent(incoming, events, 0.8);
  assert.ok(hit);
  assert.equal(hit.event.id, 2);
});

test('findDuplicateEvent 无达标项返回 null', () => {
  const incoming = { title: 'Apple new product', summary: 'Apple 发布新品', sentiment: 'bullish' };
  const events = [{ id: 1, summary: 'Tesla 召回汽车', sentiment: 'bearish' }];
  assert.equal(findDuplicateEvent(incoming, events, 0.8), null);
});

test('clusterAnalyses 按 event_id 归并', () => {
  const analyses = [
    { id: 1, event_id: 10, sentiment: 'bearish', tier: 2, created_at: '2026-06-15T06:16:00Z', news_articles: { title: 'X 诉讼', publisher: 'Wire A' } },
    { id: 2, event_id: 10, sentiment: 'bearish', tier: 1, created_at: '2026-06-15T06:47:00Z', news_articles: { title: 'X 诉讼', publisher: 'Wire B' } },
  ];
  const clusters = clusterAnalyses(analyses, 0.8);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].article_count, 2);
  // 代表项取档位最高(第1档 = tier 1)
  assert.equal(clusters[0].representative.id, 2);
  assert.deepEqual(clusters[0].sources.sort(), ['Wire A', 'Wire B']);
});

test('clusterAnalyses 兜底:event_id 不同但标题近似仍合并', () => {
  const title =
    'ROSEN Encourages BitGo Holdings Investors to Secure Counsel Before Important Deadline in Securities Class Action BTGO';
  const analyses = [
    { id: 1, event_id: 10, sentiment: 'bearish', tier: 1, created_at: '2026-06-15T06:16:00Z', news_articles: { title } },
    { id: 2, event_id: 11, sentiment: 'bearish', tier: 2, created_at: '2026-06-15T06:47:00Z', news_articles: { title } },
  ];
  const clusters = clusterAnalyses(analyses, 0.8);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].article_count, 2);
});

test('clusterAnalyses 不合并不同事件', () => {
  const analyses = [
    { id: 1, event_id: 10, sentiment: 'bullish', tier: 1, created_at: '2026-06-15T06:16:00Z', news_articles: { title: 'Apple 发布新品 iPhone AI' } },
    { id: 2, event_id: 11, sentiment: 'bearish', tier: 2, created_at: '2026-06-15T06:47:00Z', news_articles: { title: 'Tesla 召回汽车 刹车缺陷' } },
  ];
  const clusters = clusterAnalyses(analyses, 0.8);
  assert.equal(clusters.length, 2);
});
