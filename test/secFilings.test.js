import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAtomEntries,
  parseCikTickerMap,
  filingDirUrl,
  choosePrimaryDoc,
  stripHtml,
  extractItemCodes,
  hasWhitelistedItem,
  buildFilingTitle,
  buildMetadataHeader,
  parseAccessionFromUrl,
  ITEM_LABELS,
} from '../server/services/secFilings.js';

const ATOM_FEED = `<?xml version="1.0" encoding="ISO-8859-1" ?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Latest Filings - Wed, 08 Jul 2026 12:00:00 EDT</title>
  <entry>
    <title>8-K - Apple Inc. (0000320193) (Filer)</title>
    <link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/0000320193-26-000001-index.htm"/>
    <summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-07-08 &lt;b&gt;AccNo:&lt;/b&gt; 0000320193-26-000001 &lt;b&gt;Size:&lt;/b&gt; 1 MB</summary>
    <updated>2026-07-08T11:58:12-04:00</updated>
    <category scheme="https://www.sec.gov/" label="form type" term="8-K"/>
    <id>urn:tag:sec.gov,2008:accession-number=0000320193-26-000001</id>
  </entry>
  <entry>
    <title>8-K/A - SOME PRIVATE FUND LP (0001999999) (Filer)</title>
    <link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1999999/000199999926000002/0001999999-26-000002-index.htm"/>
    <summary type="html">meta</summary>
    <updated>2026-07-08T11:50:00-04:00</updated>
    <category scheme="https://www.sec.gov/" label="form type" term="8-K/A"/>
    <id>urn:tag:sec.gov,2008:accession-number=0001999999-26-000002</id>
  </entry>
</feed>`;

const ATOM_FEED_SINGLE = `<?xml version="1.0" encoding="ISO-8859-1" ?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>8-K - Berkshire Hathaway Inc (0001067983) (Filer)</title>
    <link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1067983/000106798326000003/0001067983-26-000003-index.htm"/>
    <updated>2026-07-08T09:00:00-04:00</updated>
    <category scheme="https://www.sec.gov/" label="form type" term="8-K"/>
    <id>urn:tag:sec.gov,2008:accession-number=0001067983-26-000003</id>
  </entry>
</feed>`;

// 格式演变容错:标题带 type 属性(解析为对象)、CIK 未补零、相对链接、
// id 无 accession(从链接文件名兜底)、公司名含数字括号
const ATOM_FEED_MODERN = `<?xml version="1.0" encoding="ISO-8859-1" ?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title type="text">8-K - FUND (2009) HOLDINGS LLC (320193) (Filer)</title>
    <link rel="alternate" type="text/html" href="/Archives/edgar/data/320193/000032019326000009/0000320193-26-000009-index.htm"/>
    <summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-07-09 &lt;b&gt;AccNo:&lt;/b&gt; 0000320193-26-000009</summary>
    <updated>2026-07-09T16:31:12-04:00</updated>
    <category scheme="https://www.sec.gov/" label="form type" term="8-K"/>
    <id>https://www.sec.gov/Archives/edgar/data/320193/000032019326000009/</id>
  </entry>
</feed>`;

test('parseAtomEntries:格式演变容错(标题对象/未补零 CIK/相对链接/id 无 accession)', () => {
  const entries = parseAtomEntries(ATOM_FEED_MODERN);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    formType: '8-K',
    company: 'FUND (2009) HOLDINGS LLC', // 数字括号不误判为 CIK(取最后一组)
    cik: 320193, // 未补零也解析
    accession: '0000320193-26-000009', // id 缺失时从 index 链接文件名兜底
    indexUrl:
      'https://www.sec.gov/Archives/edgar/data/320193/000032019326000009/0000320193-26-000009-index.htm', // 相对路径补全
    filedAt: '2026-07-09T20:31:12.000Z',
  });
});

test('parseAtomEntries:解析条目字段,单条目非数组兜底,残缺条目丢弃', () => {
  const entries = parseAtomEntries(ATOM_FEED);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    formType: '8-K',
    company: 'Apple Inc.',
    cik: 320193,
    accession: '0000320193-26-000001',
    indexUrl:
      'https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/0000320193-26-000001-index.htm',
    filedAt: '2026-07-08T15:58:12.000Z',
  });
  // 8-K/A 修正案保留真实表单名
  assert.equal(entries[1].formType, '8-K/A');
  assert.equal(entries[1].cik, 1999999);

  // 单 entry 时 fast-xml-parser 返回对象而非数组
  const single = parseAtomEntries(ATOM_FEED_SINGLE);
  assert.equal(single.length, 1);
  assert.equal(single[0].company, 'Berkshire Hathaway Inc');

  // 畸形输入不抛错
  assert.deepEqual(parseAtomEntries('not xml at all <<<'), []);
  assert.deepEqual(parseAtomEntries(''), []);
});

test('parseCikTickerMap:列存形状,首行主类优先,点号归一为连字符,无 ticker 行丢弃', () => {
  const json = {
    fields: ['cik', 'name', 'ticker', 'exchange'],
    data: [
      [320193, 'Apple Inc.', 'AAPL', 'Nasdaq'],
      [1652044, 'Alphabet Inc.', 'GOOGL', 'Nasdaq'],
      [1652044, 'Alphabet Inc.', 'GOOG', 'Nasdaq'],
      [1067983, 'BERKSHIRE HATHAWAY INC', 'BRK.B', 'NYSE'],
      [1999999, 'SOME PRIVATE FUND LP', '', ''],
    ],
  };
  const map = parseCikTickerMap(json);
  assert.equal(map.get(320193).ticker, 'AAPL');
  // 同 CIK 首行=主类
  assert.equal(map.get(1652044).ticker, 'GOOGL');
  // BRK.B → BRK-B(与 FMP 报价符号一致)
  assert.equal(map.get(1067983).ticker, 'BRK-B');
  assert.equal(map.get(1067983).exchange, 'NYSE');
  // 无 ticker/exchange 的未上市主体不入映射
  assert.equal(map.has(1999999), false);
  // 畸形输入
  assert.equal(parseCikTickerMap(null).size, 0);
  assert.equal(parseCikTickerMap({ fields: ['x'], data: [[1]] }).size, 0);
});

test('filingDirUrl / parseAccessionFromUrl:目录与 accession 互推', () => {
  const indexUrl =
    'https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/0000320193-26-000001-index.htm';
  const dir = filingDirUrl(indexUrl);
  assert.equal(dir, 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000001');
  assert.equal(parseAccessionFromUrl(`${dir}/a8-k.htm`), '0000320193-26-000001');
  assert.equal(parseAccessionFromUrl('https://example.com/no-accession'), null);
});

test('choosePrimaryDoc:优先 8-K 命名,排除索引/裸提交/XBRL 报表页,附件次选,兜底 txt', () => {
  // 典型目录:主文档 + 附件 + 裸提交
  assert.equal(
    choosePrimaryDoc([
      { name: '0000320193-26-000001-index.htm' },
      { name: 'a8-kq3fy26.htm' },
      { name: 'ex991.htm' },
      { name: '0000320193-26-000001.txt' },
      { name: 'R2.htm' },
    ]),
    'a8-kq3fy26.htm'
  );
  // 无 8-K 命名:取第一个非附件 html
  assert.equal(
    choosePrimaryDoc([{ name: 'ex99_1.htm' }, { name: 'pressrelease.htm' }]),
    'pressrelease.htm'
  );
  // 只有附件 html:放宽选附件(ex99 往往是随附新闻稿)
  assert.equal(choosePrimaryDoc([{ name: 'ex991.htm' }]), 'ex991.htm');
  // 无 html:兜底 txt
  assert.equal(
    choosePrimaryDoc([{ name: '0000320193-26-000001.txt' }]),
    '0000320193-26-000001.txt'
  );
  assert.equal(choosePrimaryDoc([]), null);
  assert.equal(choosePrimaryDoc(undefined), null);
});

test('stripHtml:剥标签与 ix: 标签,解码实体,折叠空白', () => {
  const html = `<html><head><style>p{color:red}</style><script>var x=1;</script></head>
  <body><ix:nonNumeric name="dei:DocumentType">8-K</ix:nonNumeric>
  <p>Item&nbsp;2.02&#160;Results of Operations &amp; Financial Condition.</p>
  <p>Revenue &gt; $1B &quot;record&quot;</p></body></html>`;
  const text = stripHtml(html);
  assert.ok(text.includes('Item 2.02 Results of Operations & Financial Condition.'));
  assert.ok(text.includes('Revenue > $1B "record"'));
  assert.ok(!text.includes('var x=1'));
  assert.ok(!text.includes('color:red'));
  assert.ok(!text.includes('<'));
});

test('extractItemCodes:去重、数值排序、容忍小节后缀', () => {
  const text =
    'Item 5.02(b) departure... Item 2.02 Results... item 9.01 Exhibits... Item 2.02 again';
  assert.deepEqual(extractItemCodes(text), ['2.02', '5.02', '9.01']);
  assert.deepEqual(extractItemCodes(''), []);
  // 经 stripHtml 后的 &nbsp; 已变普通空格
  assert.deepEqual(extractItemCodes(stripHtml('Item&nbsp;8.01 Other Events')), ['8.01']);
});

test('hasWhitelistedItem:命中即过,零条目 fail-open,空白名单不过滤', () => {
  const wl = ['2.02', '8.01'];
  assert.equal(hasWhitelistedItem(['2.02', '9.01'], wl), true);
  assert.equal(hasWhitelistedItem(['5.03', '9.01'], wl), false);
  // 零命中=解析失败,fail-open(真实 8-K 必有条目)
  assert.equal(hasWhitelistedItem([], wl), true);
  assert.equal(hasWhitelistedItem(undefined, wl), true);
  // 显式空白名单=不过滤
  assert.equal(hasWhitelistedItem(['5.03'], []), true);
});

test('buildFilingTitle / buildMetadataHeader:标题与元数据头', () => {
  const args = { formType: '8-K', company: 'Apple Inc.', items: ['2.02', '9.01'] };
  assert.equal(
    buildFilingTitle(args),
    '8-K: Apple Inc. — Item 2.02, 9.01 (Results of Operations; Exhibits)'
  );
  assert.equal(
    buildMetadataHeader(args),
    '[SEC Form 8-K | Items: 2.02 Results of Operations, 9.01 Exhibits]'
  );
  // 无条目(解析失败 fail-open 路径):标题不带条目段
  assert.equal(
    buildFilingTitle({ formType: '8-K', company: 'X Corp', items: [] }),
    '8-K: X Corp'
  );
  assert.equal(buildMetadataHeader({ formType: '8-K', items: [] }), '[SEC Form 8-K]');
  // 未知条目编码原样保留
  assert.equal(buildMetadataHeader({ formType: '8-K', items: ['6.10'] }), '[SEC Form 8-K | Items: 6.10]');
  assert.ok(ITEM_LABELS['2.02']);
});
