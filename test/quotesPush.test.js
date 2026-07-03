import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectQuoteSymbols,
  buildQuotesPayload,
  MAX_QUOTE_SYMBOLS,
} from '../server/services/quotesPush.js';

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

test('buildQuotesPayload:字段映射与双字段涨跌幅兜底', () => {
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
    price: 200,
    effective_price: 201.5,
    extended_price: 201.5,
    extended_change_percent: 0.75,
    change_percent: 1.2,
    session: 'post',
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
