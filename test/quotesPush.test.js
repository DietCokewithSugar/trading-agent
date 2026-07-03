import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectQuoteSymbols,
  buildQuotesPayload,
  positionsToQuotes,
  MAX_QUOTE_SYMBOLS,
} from '../server/services/quotesPush.js';
import { quoteDisplayFields } from '../server/services/fmp.js';

test('collectQuoteSymbols:大小写去重,持仓优先于池', () => {
  const out = collectQuoteSymbols({
    heldSymbols: ['aapl', 'MSFT'],
    poolSymbols: ['AAPL', 'nvda', 'msft'],
  });
  assert.deepEqual(out, ['AAPL', 'MSFT', 'NVDA']);
});

test('collectQuoteSymbols:cap 截断,超出的池符号被挤出', () => {
  const held = Array.from({ length: MAX_QUOTE_SYMBOLS }, (_, i) => `H${i}`);
  const out = collectQuoteSymbols({ heldSymbols: held, poolSymbols: ['POOL1', 'POOL2'] });
  assert.equal(out.length, MAX_QUOTE_SYMBOLS);
  assert.ok(!out.includes('POOL1'), '持仓占满上限时池符号不入列');
});

test('collectQuoteSymbols:空输入与空白符号', () => {
  assert.deepEqual(collectQuoteSymbols(), []);
  assert.deepEqual(collectQuoteSymbols({ heldSymbols: ['', null], poolSymbols: [' '] }), []);
});

test('quoteDisplayFields:双字段涨跌幅兜底,幂等接受已映射对象,0 不当缺失', () => {
  assert.equal(quoteDisplayFields({ changesPercentage: 1.2 }).change_percent, 1.2);
  assert.equal(quoteDisplayFields({ changePercentage: -0.5 }).change_percent, -0.5);
  // 已映射对象(change_percent)优先——positionsToQuotes 的输出再过一遍也不丢值
  assert.equal(quoteDisplayFields({ change_percent: 3.4, changesPercentage: 9 }).change_percent, 3.4);
  assert.equal(quoteDisplayFields({ changesPercentage: 0 }).change_percent, 0);
  assert.equal(quoteDisplayFields({ changesPercentage: 'garbage' }).change_percent, null);
  assert.deepEqual(quoteDisplayFields(undefined), {
    session: null,
    extended_price: null,
    extended_change_percent: null,
    change_percent: null,
  });
});

test('positionsToQuotes:取估值现价,跳过报价缺失(live_quote=false)与非法价的持仓', () => {
  const map = positionsToQuotes([
    {
      symbol: 'aapl',
      live_quote: true,
      current_price: 201.5,
      session: 'post',
      extended_price: 201.5,
      extended_change_percent: 0.75,
      change_percent: 1.2,
    },
    // 报价缺失的持仓现价是成本价兜底,不能当实时价广播
    { symbol: 'MSFT', live_quote: false, current_price: 100 },
    { symbol: 'BAD', live_quote: true, current_price: 0 },
    { symbol: '', live_quote: true, current_price: 5 },
  ]);
  assert.deepEqual([...map.keys()], ['AAPL']);
  assert.equal(map.get('AAPL').effective_price, 201.5);
  assert.equal(map.get('AAPL').change_percent, 1.2);
  assert.deepEqual(positionsToQuotes(), new Map());
});

test('buildQuotesPayload:字段映射,effective_price 缺失回退 price', () => {
  const map = new Map([
    [
      'AAPL',
      {
        price: 200,
        effective_price: 201.5,
        extended_price: 201.5,
        extended_change_percent: 0.75,
        changesPercentage: 1.2,
        session: 'post',
      },
    ],
    // 老字段名 changePercentage 也要被识别;effective_price 缺失回退 price
    ['MSFT', { price: 400, changePercentage: -0.5, session: 'post' }],
  ]);
  const payload = buildQuotesPayload(map, { session: 'post', now: new Date('2026-07-03T21:00:00Z') });
  assert.equal(payload.ts, '2026-07-03T21:00:00.000Z');
  assert.equal(payload.session, 'post');
  assert.deepEqual(payload.quotes.AAPL, {
    effective_price: 201.5,
    session: 'post',
    extended_price: 201.5,
    extended_change_percent: 0.75,
    change_percent: 1.2,
  });
  assert.equal(payload.quotes.MSFT.effective_price, 400);
  assert.equal(payload.quotes.MSFT.change_percent, -0.5);
  assert.equal(payload.quotes.MSFT.extended_price, null);
  assert.equal(payload.quotes.MSFT.extended_change_percent, null);
});

test('buildQuotesPayload:非有限/≤0 的有效价整条剔除,全无效返回 null', () => {
  const map = new Map([
    ['BAD1', { price: 0, effective_price: 0 }],
    ['BAD2', { price: NaN }],
    ['BAD3', null],
  ]);
  assert.equal(buildQuotesPayload(map, { session: 'regular' }), null);

  const mixed = new Map([
    ['BAD', { price: -1 }],
    ['GOOD', { price: 10, effective_price: 10.2, session: 'pre' }],
  ]);
  const payload = buildQuotesPayload(mixed, { session: 'pre' });
  assert.deepEqual(Object.keys(payload.quotes), ['GOOD']);
});

test('buildQuotesPayload:quote 自带 session 缺失时用顶层 session 兜底,非 Map 输入返回 null', () => {
  const map = new Map([['SPY', { price: 500, effective_price: 500 }]]);
  const payload = buildQuotesPayload(map, { session: 'closed' });
  assert.equal(payload.quotes.SPY.session, 'closed');
  assert.equal(buildQuotesPayload(null), null);
  assert.equal(buildQuotesPayload(undefined), null);
});

test('buildQuotesPayload:持仓映射(positionsToQuotes 输出)可直接作为输入', () => {
  const held = positionsToQuotes([
    { symbol: 'NVDA', live_quote: true, current_price: 101.5, session: 'pre', change_percent: 0 },
  ]);
  const payload = buildQuotesPayload(held, { session: 'pre' });
  assert.equal(payload.quotes.NVDA.effective_price, 101.5);
  assert.equal(payload.quotes.NVDA.change_percent, 0, '涨跌幅 0 不能被当成缺失');
  assert.equal(payload.quotes.NVDA.session, 'pre');
});
