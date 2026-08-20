import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTORS,
  SECTOR_KEYS,
  UNCLASSIFIED,
  normalizeSector,
  sectorMeta,
  sectorProviderNames,
  netSentimentScore,
  summarizeSectorSentiment,
} from '../server/services/sectors.js';

test('11 个 SPDR 板块口径齐全且 key 唯一', () => {
  assert.equal(SECTORS.length, 11);
  assert.equal(new Set(SECTOR_KEYS).size, 11);
  for (const etf of ['XLV', 'XLC', 'XLE', 'XLF', 'XLRE', 'XLK', 'XLY', 'XLP', 'XLI', 'XLU', 'XLB']) {
    assert.ok(SECTOR_KEYS.includes(etf), `缺少 ${etf}`);
  }
});

test('数据源标准行业名归一到板块', () => {
  assert.equal(normalizeSector('Technology'), 'XLK');
  assert.equal(normalizeSector('Healthcare'), 'XLV');
  assert.equal(normalizeSector('Financial Services'), 'XLF');
  assert.equal(normalizeSector('Consumer Cyclical'), 'XLY');
  assert.equal(normalizeSector('Consumer Defensive'), 'XLP');
  assert.equal(normalizeSector('Communication Services'), 'XLC');
  assert.equal(normalizeSector('Industrials'), 'XLI');
  assert.equal(normalizeSector('Energy'), 'XLE');
  assert.equal(normalizeSector('Utilities'), 'XLU');
  assert.equal(normalizeSector('Real Estate'), 'XLRE');
  assert.equal(normalizeSector('Basic Materials'), 'XLB');
});

test('GICS 别名/大小写/空格差异同样归一', () => {
  assert.equal(normalizeSector('Health Care'), 'XLV');
  assert.equal(normalizeSector('  health care '), 'XLV');
  assert.equal(normalizeSector('Financials'), 'XLF');
  assert.equal(normalizeSector('Consumer Discretionary'), 'XLY');
  assert.equal(normalizeSector('Consumer Staples'), 'XLP');
  assert.equal(normalizeSector('Information Technology'), 'XLK');
  assert.equal(normalizeSector('Materials'), 'XLB');
  assert.equal(normalizeSector('Industrial Goods'), 'XLI');
});

test('ETF 代码与中文名可直接作为筛选参数', () => {
  assert.equal(normalizeSector('XLK'), 'XLK');
  assert.equal(normalizeSector('xlre'), 'XLRE');
  assert.equal(normalizeSector('科技'), 'XLK');
});

test('空值/未知分类归为 null(调用方落到未分类桶)', () => {
  assert.equal(normalizeSector(null), null);
  assert.equal(normalizeSector(undefined), null);
  assert.equal(normalizeSector(''), null);
  assert.equal(normalizeSector('   '), null);
  assert.equal(normalizeSector('Cryptocurrency'), null);
});

test('板块元信息与库内原始行业名清单', () => {
  assert.deepEqual(sectorMeta('XLV'), {
    key: 'XLV',
    etf: 'XLV',
    name: 'Healthcare',
    label: '医疗保健',
  });
  assert.equal(sectorMeta('NOPE'), null);
  const names = sectorProviderNames('XLV');
  assert.ok(names.includes('Healthcare'));
  assert.ok(names.includes('Health Care'));
  // 别名清单必须能被自身归一(数据库端 .in() 过滤与 JS 端聚合口径一致)
  for (const key of SECTOR_KEYS) {
    for (const name of sectorProviderNames(key)) assert.equal(normalizeSector(name), key);
  }
  assert.deepEqual(sectorProviderNames('NOPE'), []);
});

test('净情绪分:方向与边界', () => {
  assert.equal(netSentimentScore(1, 0), 1);
  assert.equal(netSentimentScore(0, 1), -1);
  assert.equal(netSentimentScore(1, 1), 0);
  assert.equal(netSentimentScore(3, 1), 0.5);
  assert.equal(netSentimentScore(0, 0), null); // 无非中性样本
});

const row = (sector, sentiment, tier, confidence, symbol = 'AAA') => ({
  sector,
  sentiment,
  tier,
  final_confidence: confidence,
  symbol,
});

test('板块聚合:计数、权重与净情绪分', () => {
  const out = summarizeSectorSentiment([
    row('Technology', 'bullish', 1, 0.8, 'NVDA'),
    row('Technology', 'bearish', 4, 0.4, 'INTC'),
    row('Technology', 'neutral', null, null, 'AAPL'),
    row('Energy', 'bearish', 2, 0.6, 'XOM'),
  ]);
  const tech = out.sectors.find((s) => s.key === 'XLK');
  assert.equal(tech.bullish, 1);
  assert.equal(tech.bearish, 1);
  assert.equal(tech.neutral, 1);
  assert.equal(tech.total, 3);
  // 一档 0.8 的利好权重远高于四档 0.4 的利空 → 板块整体仍偏利好
  assert.ok(tech.score > 0.5, `期望明显利好,实际 ${tech.score}`);
  const energy = out.sectors.find((s) => s.key === 'XLE');
  assert.equal(energy.score, -1);
  assert.equal(energy.bullish, 0);
  assert.equal(energy.bearish, 1);
});

test('板块聚合:未知/缺失行业进未分类桶,不污染板块', () => {
  const out = summarizeSectorSentiment([
    row(null, 'bullish', 1, 0.9, 'AAA'),
    row('Cryptocurrency', 'bearish', 1, 0.9, 'BBB'),
    row('Technology', 'bullish', 2, 0.7, 'MSFT'),
  ]);
  assert.equal(out.unclassified.total, 2);
  assert.equal(out.unclassified.score, 0);
  assert.equal(out.totals.total, 3);
  assert.equal(out.totals.classified, 1);
  assert.equal(out.sectors.find((s) => s.key === 'XLK').total, 1);
});

test('板块聚合:无样本板块也返回(看板行数稳定)', () => {
  const out = summarizeSectorSentiment([]);
  assert.equal(out.sectors.length, 11);
  assert.deepEqual(
    out.sectors.map((s) => s.key),
    SECTOR_KEYS
  );
  for (const s of out.sectors) {
    assert.equal(s.total, 0);
    assert.equal(s.score, null);
    assert.deepEqual(s.symbols, []);
  }
  assert.equal(out.totals.score, null);
  assert.equal(out.unclassified.key, UNCLASSIFIED);
});

test('板块聚合:个股明细按信号条数取前若干', () => {
  const rows = [
    row('Technology', 'bullish', 1, 0.9, 'NVDA'),
    row('Technology', 'bullish', 2, 0.8, 'NVDA'),
    row('Technology', 'bearish', 1, 0.9, 'AMD'),
    row('Technology', 'neutral', null, null, 'MSFT'),
  ];
  const tech = summarizeSectorSentiment(rows, { topSymbols: 2 }).sectors.find(
    (s) => s.key === 'XLK'
  );
  assert.equal(tech.symbols.length, 2);
  assert.equal(tech.symbols[0].symbol, 'NVDA');
  assert.equal(tech.symbols[0].bullish, 2);
  assert.equal(tech.symbols[0].score, 1);
  assert.equal(tech.symbols[1].symbol, 'AMD');
  assert.equal(tech.symbols[1].score, -1);
});

test('板块聚合:缺置信度按 0.5 保守计,缺档位不崩', () => {
  const out = summarizeSectorSentiment([
    { sector: 'Energy', sentiment: 'bullish', symbol: 'xom' },
    { sector: 'Energy', sentiment: 'bearish', tier: 1, confidence: 0.5, symbol: 'CVX' },
    null,
  ]);
  const energy = out.sectors.find((s) => s.key === 'XLE');
  assert.equal(energy.total, 2);
  assert.ok(Number.isFinite(energy.score));
  // 代码统一大写(前端点板块个股直接当代码用)
  assert.ok(energy.symbols.some((s) => s.symbol === 'XOM'));
});
