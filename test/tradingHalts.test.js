import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHaltsRss,
  etDateTimeToUtc,
  isHaltActive,
  buildActiveHaltMap,
} from '../server/services/tradingHalts.js';

const HALTS_RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:ndaq="http://www.nasdaqtrader.com/">
  <channel>
    <title>Trading Halts</title>
    <item>
      <title>HALT1</title>
      <ndaq:IssueSymbol>HALT1</ndaq:IssueSymbol>
      <ndaq:IssueName>Halted Corp One</ndaq:IssueName>
      <ndaq:ReasonCode>T1</ndaq:ReasonCode>
      <ndaq:HaltDate>07/09/2026</ndaq:HaltDate>
      <ndaq:HaltTime>09:45:00</ndaq:HaltTime>
      <ndaq:ResumptionDate></ndaq:ResumptionDate>
      <ndaq:ResumptionQuoteTime></ndaq:ResumptionQuoteTime>
      <ndaq:ResumptionTradeTime></ndaq:ResumptionTradeTime>
    </item>
    <item>
      <title>DONE.A</title>
      <ndaq:IssueSymbol>DONE.A</ndaq:IssueSymbol>
      <ndaq:ReasonCode>LUDP</ndaq:ReasonCode>
      <ndaq:HaltDate>07/09/2026</ndaq:HaltDate>
      <ndaq:HaltTime>10:00:00</ndaq:HaltTime>
      <ndaq:ResumptionDate>07/09/2026</ndaq:ResumptionDate>
      <ndaq:ResumptionQuoteTime>10:05:00</ndaq:ResumptionQuoteTime>
      <ndaq:ResumptionTradeTime>10:10:00</ndaq:ResumptionTradeTime>
    </item>
    <item>
      <title>SOON</title>
      <ndaq:IssueSymbol>SOON</ndaq:IssueSymbol>
      <ndaq:ReasonCode>T2</ndaq:ReasonCode>
      <ndaq:HaltDate>07/09/2026</ndaq:HaltDate>
      <ndaq:HaltTime>11:00:00</ndaq:HaltTime>
      <ndaq:ResumptionDate>07/09/2026</ndaq:ResumptionDate>
      <ndaq:ResumptionQuoteTime>15:55:00</ndaq:ResumptionQuoteTime>
      <ndaq:ResumptionTradeTime>16:00:00</ndaq:ResumptionTradeTime>
    </item>
  </channel>
</rss>`;

const SINGLE_ITEM_RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:ndaq="http://www.nasdaqtrader.com/">
  <channel>
    <item>
      <ndaq:IssueSymbol>ONLY</ndaq:IssueSymbol>
      <ndaq:ReasonCode>H10</ndaq:ReasonCode>
      <ndaq:HaltDate>07/08/2026</ndaq:HaltDate>
      <ndaq:HaltTime>08:00:00</ndaq:HaltTime>
      <ndaq:ResumptionTradeTime></ndaq:ResumptionTradeTime>
    </item>
  </channel>
</rss>`;

test('parseHaltsRss:去命名空间字段提取,符号归一,单 item 非数组兜底', () => {
  const items = parseHaltsRss(HALTS_RSS);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {
    symbol: 'HALT1',
    reasonCode: 'T1',
    haltDate: '07/09/2026',
    haltTime: '09:45:00',
    resumptionDate: null,
    resumptionQuoteTime: null,
    resumptionTradeTime: null,
  });
  // 点号符号归一为连字符
  assert.equal(items[1].symbol, 'DONE-A');
  assert.equal(items[1].resumptionTradeTime, '10:10:00');

  const single = parseHaltsRss(SINGLE_ITEM_RSS);
  assert.equal(single.length, 1);
  assert.equal(single[0].symbol, 'ONLY');
  assert.equal(single[0].reasonCode, 'H10');

  assert.deepEqual(parseHaltsRss('not xml <<'), []);
  assert.deepEqual(parseHaltsRss(''), []);
});

test('etDateTimeToUtc:EST/EDT 偏移与非法输入', () => {
  // 7 月为 EDT(-04:00)
  assert.equal(
    etDateTimeToUtc('07/09/2026', '09:45:00').toISOString(),
    '2026-07-09T13:45:00.000Z'
  );
  // 1 月为 EST(-05:00)
  assert.equal(
    etDateTimeToUtc('01/15/2026', '09:45:00').toISOString(),
    '2026-01-15T14:45:00.000Z'
  );
  // HH:MM(无秒)也接受
  assert.equal(
    etDateTimeToUtc('07/09/2026', '09:45').toISOString(),
    '2026-07-09T13:45:00.000Z'
  );
  assert.equal(etDateTimeToUtc('2026-07-09', '09:45:00'), null);
  assert.equal(etDateTimeToUtc('07/09/2026', 'bad'), null);
  assert.equal(etDateTimeToUtc(null, null), null);
});

test('isHaltActive:无恢复时间生效,已过恢复时间复牌,将来恢复仍生效', () => {
  const noon = new Date('2026-07-09T16:00:00Z'); // ET 12:00 EDT
  assert.equal(isHaltActive({ resumptionTradeTime: null }, noon), true);
  // 10:10 ET 复牌,正午已过 → 不再生效
  assert.equal(
    isHaltActive(
      { resumptionDate: '07/09/2026', resumptionTradeTime: '10:10:00' },
      noon
    ),
    false
  );
  // 16:00 ET 复牌,正午未到 → 仍生效
  assert.equal(
    isHaltActive(
      { resumptionDate: '07/09/2026', resumptionTradeTime: '16:00:00' },
      noon
    ),
    true
  );
  // 恢复时间存在但不可解析:保守仍视为停牌
  assert.equal(
    isHaltActive({ resumptionDate: 'garbage', resumptionTradeTime: 'bad' }, noon),
    true
  );
});

test('buildActiveHaltMap:只留生效中停牌,同符号取最新', () => {
  const noon = new Date('2026-07-09T16:00:00Z');
  const items = parseHaltsRss(HALTS_RSS);
  const map = buildActiveHaltMap(items, noon);
  assert.equal(map.has('HALT1'), true); // 无恢复时间
  assert.equal(map.has('DONE-A'), false); // 10:10 已复牌
  assert.equal(map.has('SOON'), true); // 16:00 ET 才复牌

  // 同符号两条:早间已复牌 + 午后再停 → 取最新(仍停牌)
  const twice = [
    { symbol: 'X', haltDate: '07/09/2026', haltTime: '09:30:00', resumptionDate: '07/09/2026', resumptionTradeTime: '09:40:00' },
    { symbol: 'X', haltDate: '07/09/2026', haltTime: '11:30:00', resumptionTradeTime: null },
  ];
  assert.equal(buildActiveHaltMap(twice, noon).has('X'), true);
  // 反序输入同样取最新
  assert.equal(buildActiveHaltMap([...twice].reverse(), noon).has('X'), true);
});
