import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBuyEligibility, normalizeExchange } from '../server/services/eligibility.js';

// 默认门槛:交易所白名单 NASDAQ/NYSE/AMEX,最低股价 $2,最小市值 $3 亿,最低日均美元成交额 $500 万

test('大盘流动性充足的标的放行', () => {
  const r = checkBuyEligibility({
    profile: { exchange: 'NASDAQ', marketCap: 5e9, averageVolume: 2e6 },
    price: 50,
  });
  assert.equal(r.ok, true);
});

test('仙股拦截(低于最低股价)', () => {
  const r = checkBuyEligibility({
    profile: { exchange: 'NASDAQ', marketCap: 5e9, averageVolume: 1e7 },
    price: 1.5,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /股价/);
});

test('微盘拦截(低于最小市值)', () => {
  const r = checkBuyEligibility({
    profile: { exchange: 'NYSE', marketCap: 100e6, averageVolume: 1e6 },
    price: 10,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /市值/);
});

test('低流动性拦截(日均美元成交额不足)', () => {
  // 10 万股 × $8 = $80 万/日 < $500 万
  const r = checkBuyEligibility({
    profile: { exchange: 'NYSE', marketCap: 1e9, averageVolume: 1e5 },
    price: 8,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /成交额/);
});

test('档案缺失 fail-closed', () => {
  assert.equal(checkBuyEligibility({ profile: null, price: 50 }).ok, false);
  assert.equal(
    checkBuyEligibility({ profile: { exchange: 'NASDAQ', averageVolume: 1e7 }, price: 50 }).ok,
    false,
    '市值缺失也拦截'
  );
});

test('交易所白名单:OTC/粉单拦截', () => {
  for (const exchange of ['OTC', 'PNK', 'OTCMKTS']) {
    const r = checkBuyEligibility({
      profile: { exchange, marketCap: 5e9, averageVolume: 2e6 },
      price: 50,
    });
    assert.equal(r.ok, false, `${exchange} 应被拦截`);
    assert.match(r.reason, /交易所/);
  }
});

test('交易所白名单:大小写不敏感 + AMEX 别名放行', () => {
  for (const exchange of ['nasdaq', 'Nyse', 'AMEX', 'NYSE American', 'ASE', 'NYSE MKT']) {
    const r = checkBuyEligibility({
      profile: { exchange, marketCap: 5e9, averageVolume: 2e6 },
      price: 50,
    });
    assert.equal(r.ok, true, `${exchange} 应放行`);
  }
});

test('交易所缺失 fail-closed', () => {
  const r = checkBuyEligibility({
    profile: { marketCap: 5e9, averageVolume: 2e6 },
    price: 50,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /交易所 未知/);
});

test('ETF/基金拦截,字段缺失放行', () => {
  const base = { exchange: 'NYSE', marketCap: 5e9, averageVolume: 2e6 };
  assert.equal(checkBuyEligibility({ profile: { ...base, isEtf: true }, price: 50 }).ok, false);
  assert.equal(checkBuyEligibility({ profile: { ...base, isFund: true }, price: 50 }).ok, false);
  // 字段缺失或显式 false 不拦截(正常个股缺该字段很常见,fail-closed 会误杀)
  assert.equal(checkBuyEligibility({ profile: base, price: 50 }).ok, true);
  assert.equal(
    checkBuyEligibility({ profile: { ...base, isEtf: false, isFund: false }, price: 50 }).ok,
    true
  );
});

test('normalizeExchange:归一与别名', () => {
  assert.equal(normalizeExchange(' nasdaq '), 'NASDAQ');
  assert.equal(normalizeExchange('NYSE American'), 'AMEX');
  assert.equal(normalizeExchange('ase'), 'AMEX');
  assert.equal(normalizeExchange(''), null);
  assert.equal(normalizeExchange(null), null);
  assert.equal(normalizeExchange(undefined), null);
});

// ── 上市名录校验(028,reference 参数)──

const GOOD_PROFILE = { exchange: 'NASDAQ', marketCap: 5e9, averageVolume: 2e6 };
const NORMAL_ENTRY = {
  symbol: 'AAPL', exchange: 'NASDAQ', isEtf: false, isTestIssue: false, financialStatus: 'N',
};

test('名录未加载/未传:整组跳过,行为与旧版一致', () => {
  assert.equal(checkBuyEligibility({ profile: GOOD_PROFILE, price: 50 }).ok, true);
  assert.equal(
    checkBuyEligibility({ profile: GOOD_PROFILE, price: 50, reference: null }).ok,
    true
  );
  assert.equal(
    checkBuyEligibility({ profile: GOOD_PROFILE, price: 50, reference: { loaded: false, entry: null } }).ok,
    true
  );
});

test('名录已加载但无条目:疑似 OTC/退市拦截', () => {
  const r = checkBuyEligibility({
    profile: GOOD_PROFILE,
    price: 50,
    reference: { loaded: true, entry: null },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /名录/);
});

test('名录条目正常:放行', () => {
  const r = checkBuyEligibility({
    profile: GOOD_PROFILE,
    price: 50,
    reference: { loaded: true, entry: NORMAL_ENTRY },
  });
  assert.equal(r.ok, true);
});

test('测试标的/财务异常/名录 ETF 拦截', () => {
  const base = { profile: GOOD_PROFILE, price: 50 };
  assert.match(
    checkBuyEligibility({ ...base, reference: { loaded: true, entry: { ...NORMAL_ENTRY, isTestIssue: true } } }).reason,
    /测试标的/
  );
  for (const code of ['D', 'E', 'Q']) {
    const r = checkBuyEligibility({
      ...base,
      reference: { loaded: true, entry: { ...NORMAL_ENTRY, financialStatus: code } },
    });
    assert.equal(r.ok, false, `${code} 应拦截`);
    assert.match(r.reason, /异常/);
  }
  assert.match(
    checkBuyEligibility({ ...base, reference: { loaded: true, entry: { ...NORMAL_ENTRY, isEtf: true } } }).reason,
    /ETF/
  );
  // 财务状态缺失(otherlisted 无该字段)正常放行
  assert.equal(
    checkBuyEligibility({ ...base, reference: { loaded: true, entry: { ...NORMAL_ENTRY, financialStatus: null } } }).ok,
    true
  );
});

test('名录交易所是补充校验:两源都须过白名单', () => {
  // 名录说 ARCA(默认白名单外)→ 拒,即使行情商 profile 说 NASDAQ
  const r = checkBuyEligibility({
    profile: GOOD_PROFILE,
    price: 50,
    reference: { loaded: true, entry: { ...NORMAL_ENTRY, exchange: 'ARCA' } },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /名录交易所/);
  // 名录交易所缺失(极端数据缺口)不因该项拦截
  assert.equal(
    checkBuyEligibility({
      profile: GOOD_PROFILE,
      price: 50,
      reference: { loaded: true, entry: { ...NORMAL_ENTRY, exchange: null } },
    }).ok,
    true
  );
});
