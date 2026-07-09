import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDirectorySymbol,
  splitPipeDirectory,
  parseNasdaqListed,
  parseOtherListed,
  buildReferenceMap,
} from '../server/services/symbolReference.js';
import { mapOtherExchangeCode, classifyFinancialStatus } from '../server/services/eligibility.js';

const NASDAQ_LISTED = [
  'Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares',
  'AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N',
  'SNDL|SNDL Inc. - Common Shares|S|N|D|100|N|N',
  'BKRUP|Bankrupt Corp - Common Stock|S|N|Q|100|N|N',
  'ZAZZT|Test Pilot Za - Class A Common Stock|G|Y|N|100|N|N',
  'QQQ|Invesco QQQ Trust, Series 1|G|N|N|100|Y|N',
  'File Creation Time: 0709202612:31|||||||',
].join('\r\n');

const OTHER_LISTED = [
  'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
  'A|Agilent Technologies, Inc. Common Stock|N|A|N|100|N|A',
  'BRK.A|Berkshire Hathaway Inc. Class A Common Stock|N|BRK A|N|1|N|BRK.A',
  'SPY|SPDR S&P 500 ETF Trust|P|SPY|Y|100|N|SPY',
  'IEXY|IEX Sample Listing|V|IEXY|N|100|N|IEXY',
  'FOO.WS|Foo Corp Warrants|A|FOO WS|N|100|N|FOO+',
  'File Creation Time: 0709202612:32|||||||',
].join('\n');

test('splitPipeDirectory:表头/尾行处理,无尾行=残缺返回 null,CRLF 兼容', () => {
  const parsed = splitPipeDirectory(NASDAQ_LISTED);
  assert.equal(parsed.rows.length, 5);
  assert.equal(parsed.creationTime, '0709202612:31');
  // 无 File Creation Time 尾行:下载不完整
  assert.equal(splitPipeDirectory('Symbol|Name\nAAPL|Apple'), null);
  assert.equal(splitPipeDirectory(''), null);
  assert.equal(splitPipeDirectory(null), null);
});

test('parseNasdaqListed:字段映射与 Y/N 布尔化', () => {
  const { entries, creationTime } = parseNasdaqListed(NASDAQ_LISTED);
  assert.equal(creationTime, '0709202612:31');
  assert.equal(entries.length, 5);
  const aapl = entries.find((e) => e.symbol === 'AAPL');
  assert.deepEqual(aapl, {
    symbol: 'AAPL',
    securityName: 'Apple Inc. - Common Stock',
    marketCategory: 'Q',
    isTestIssue: false,
    financialStatus: 'N',
    roundLot: 100,
    isEtf: false,
    exchange: 'NASDAQ',
    listingSource: 'nasdaq',
  });
  assert.equal(entries.find((e) => e.symbol === 'SNDL').financialStatus, 'D');
  assert.equal(entries.find((e) => e.symbol === 'ZAZZT').isTestIssue, true);
  assert.equal(entries.find((e) => e.symbol === 'QQQ').isEtf, true);
  // 残缺文件整体返回 null
  assert.equal(parseNasdaqListed('Symbol|Name\nAAPL|Apple'), null);
});

test('parseOtherListed:ACT 符号点号归一,交易所单字母映射', () => {
  const { entries } = parseOtherListed(OTHER_LISTED);
  assert.equal(entries.length, 5);
  const brk = entries.find((e) => e.symbol === 'BRK-A');
  assert.ok(brk, 'BRK.A 应归一为 BRK-A');
  assert.equal(brk.exchange, 'NYSE');
  assert.equal(brk.roundLot, 1);
  assert.equal(brk.financialStatus, null); // otherlisted 无财务状态字段
  assert.equal(entries.find((e) => e.symbol === 'SPY').exchange, 'ARCA');
  assert.equal(entries.find((e) => e.symbol === 'SPY').isEtf, true);
  assert.equal(entries.find((e) => e.symbol === 'IEXY').exchange, 'IEX');
  assert.equal(entries.find((e) => e.symbol === 'FOO-WS').symbol, 'FOO-WS'); // 权证独立键
});

test('normalizeDirectorySymbol / mapOtherExchangeCode', () => {
  assert.equal(normalizeDirectorySymbol(' brk.b '), 'BRK-B');
  assert.equal(normalizeDirectorySymbol(''), null);
  assert.equal(normalizeDirectorySymbol(null), null);
  assert.equal(mapOtherExchangeCode('A'), 'AMEX');
  assert.equal(mapOtherExchangeCode('N'), 'NYSE');
  assert.equal(mapOtherExchangeCode('P'), 'ARCA');
  assert.equal(mapOtherExchangeCode('Z'), 'BATS');
  assert.equal(mapOtherExchangeCode('V'), 'IEX');
  assert.equal(mapOtherExchangeCode('X'), null);
  assert.equal(mapOtherExchangeCode(''), null);
});

test('classifyFinancialStatus:N/空正常,D/E/Q/G/H/J/K 异常,未知码保守异常', () => {
  assert.equal(classifyFinancialStatus('N').abnormal, false);
  assert.equal(classifyFinancialStatus('').abnormal, false);
  assert.equal(classifyFinancialStatus(null).abnormal, false);
  for (const code of ['D', 'E', 'Q', 'G', 'H', 'J', 'K']) {
    const r = classifyFinancialStatus(code);
    assert.equal(r.abnormal, true, `${code} 应为异常`);
    assert.ok(r.label && !r.label.startsWith('未知'), `${code} 应有明确标签`);
  }
  assert.equal(classifyFinancialStatus('Z').abnormal, true);
  assert.ok(classifyFinancialStatus('Z').label.includes('未知'));
});

test('buildReferenceMap:合并与 nasdaq 优先', () => {
  const { entries: nasdaq } = parseNasdaqListed(NASDAQ_LISTED);
  const { entries: other } = parseOtherListed(OTHER_LISTED);
  const map = buildReferenceMap(nasdaq, other);
  assert.equal(map.size, 10);
  assert.equal(map.get('AAPL').exchange, 'NASDAQ');
  assert.equal(map.get('BRK-A').exchange, 'NYSE');
  // 同符号冲突:nasdaq 优先
  const conflicted = buildReferenceMap(
    [{ symbol: 'DUP', listingSource: 'nasdaq' }],
    [{ symbol: 'DUP', listingSource: 'other' }]
  );
  assert.equal(conflicted.get('DUP').listingSource, 'nasdaq');
});
