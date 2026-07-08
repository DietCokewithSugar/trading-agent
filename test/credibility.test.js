import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreSource,
  recencyScore,
  computeFinalConfidence,
  extractDomain,
  isPressRelease,
  isSelfIssued,
} from '../server/services/credibility.js';
import { computeTier } from '../server/services/deepseek.js';

test('scoreSource:按原文域名分层,FMP 转发扣聚合折价', () => {
  // Yahoo RSS 直达 Reuters 原文:0.95 不扣
  assert.equal(
    scoreSource({ url: 'https://www.reuters.com/markets/x', source: 'yahoo' }).score,
    0.95
  );
  // 同一原文经 FMP 聚合:0.95 - 0.03
  assert.equal(
    scoreSource({ url: 'https://www.reuters.com/markets/x', source: 'fmp-stock' }).score,
    0.92
  );
  // FMP 公告端点按公司公告档计分:0.90 - 0.03
  assert.equal(
    scoreSource({ url: 'https://example.com/pr', source: 'fmp-press' }).score,
    0.87
  );
  // 未知域名有原文链接:0.4(经 FMP 再扣 0.03)
  assert.equal(scoreSource({ url: 'https://tiny-blog.io/a', source: 'yahoo' }).score, 0.4);
  assert.equal(scoreSource({ url: 'https://tiny-blog.io/a', source: 'fmp-stock' }).score, 0.37);
  // 连 URL 都没有:最低档
  assert.equal(scoreSource({ url: '', source: 'fmp-general' }).score, 0.22);
  // 域名不认识时退回 publisher 模糊匹配
  assert.equal(
    scoreSource({ url: 'https://syndication.example.com/x', publisher: 'Reuters', source: 'yahoo' })
      .score,
    0.95
  );
});

test('scoreSource:SEC 官方直抓按监管披露满分档,按渠道而非域名选中', () => {
  const filingUrl = 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/a8-k.htm';
  // 官方直抓渠道:1.00 满分,无聚合折价
  const direct = scoreSource({ url: filingUrl, source: 'sec-filings' });
  assert.equal(direct.score, 1.0);
  assert.equal(direct.label, '监管披露');
  assert.equal(direct.domain, 'sec.gov');
  // 同一 sec.gov 链接经其他渠道转发:仍走域名匹配的 0.95 档(证明按渠道选档)
  assert.equal(scoreSource({ url: filingUrl, source: 'yahoo' }).score, 0.95);
  assert.equal(scoreSource({ url: filingUrl, source: 'fmp-stock' }).score, 0.92);
});

test('isSelfIssued:公司自述类 = 新闻稿 + 监管披露;isPressRelease 口径不变', () => {
  assert.equal(isSelfIssued({ source: 'sec-filings', url: 'https://www.sec.gov/Archives/x.htm' }), true);
  assert.equal(isSelfIssued({ source: 'fmp-press', url: 'https://x.com/a' }), true);
  assert.equal(isSelfIssued({ source: 'yahoo', url: 'https://www.businesswire.com/a' }), true);
  assert.equal(isSelfIssued({ source: 'yahoo', url: 'https://www.reuters.com/a' }), false);
  // 监管披露不属于新闻稿统计口径(is_press 桶/advisor press 规则的证据链不被污染)
  assert.equal(isPressRelease({ source: 'sec-filings', url: 'https://www.sec.gov/Archives/x.htm' }), false);
});

test('extractDomain:去 www 前缀,保留有意义子域,畸形 URL 返回 null', () => {
  assert.equal(extractDomain('https://www.wsj.com/articles/x'), 'wsj.com');
  assert.equal(extractDomain('https://finance.yahoo.com/news/x'), 'finance.yahoo.com');
  assert.equal(extractDomain('not a url'), null);
});

test('isPressRelease:公告端点与新闻稿通道域名', () => {
  assert.equal(isPressRelease({ source: 'fmp-press', url: 'https://x.com/a' }), true);
  assert.equal(isPressRelease({ source: 'yahoo', url: 'https://www.businesswire.com/a' }), true);
  assert.equal(isPressRelease({ source: 'yahoo', url: 'https://www.prnewswire.com/a' }), true);
  assert.equal(isPressRelease({ source: 'yahoo', url: 'https://www.reuters.com/a' }), false);
  assert.equal(isPressRelease({ source: 'fmp-stock', url: '' }), false);
});

test('recencyScore:1 小时内满分,24 小时以上 0.5,缺失 0.7', () => {
  assert.equal(recencyScore(new Date().toISOString()), 1);
  assert.equal(recencyScore(new Date(Date.now() - 30 * 3600_000).toISOString()), 0.5);
  assert.equal(recencyScore(null), 0.7);
  // 12 小时:1 - 0.5×11/23 ≈ 0.7609,线性衰减区间
  const mid = recencyScore(new Date(Date.now() - 12 * 3600_000).toISOString());
  assert.ok(mid > 0.5 && mid < 1);
});

test('computeFinalConfidence:四因子相乘并截断到 [0,1]', () => {
  const now = new Date().toISOString();
  // 0.95 × 0.9 × 1.0 × 1.0(一档)
  assert.equal(
    computeFinalConfidence({ sourceScore: 0.95, confidence: 0.9, publishedAt: now, tier: 1 }),
    0.855
  );
  // 二档材料性 0.9
  assert.equal(
    computeFinalConfidence({ sourceScore: 1, confidence: 1, publishedAt: now, tier: 2 }),
    0.9
  );
  // 监管披露满分来源:1.00 × 0.9 × 1.0 × 1.0(一档)
  assert.equal(
    computeFinalConfidence({ sourceScore: 1.0, confidence: 0.9, publishedAt: now, tier: 1 }),
    0.9
  );
  // 置信度缺失按 0.7;来源缺失按未知 0.4
  assert.equal(
    computeFinalConfidence({ sourceScore: undefined, confidence: undefined, publishedAt: now, tier: 1 }),
    0.28
  );
});

test('computeTier:程度×范围的四档矩阵', () => {
  assert.equal(computeTier('high', 'wide'), 1);
  assert.equal(computeTier('high', 'narrow'), 2);
  assert.equal(computeTier('low', 'wide'), 3);
  assert.equal(computeTier('low', 'narrow'), 4);
});
