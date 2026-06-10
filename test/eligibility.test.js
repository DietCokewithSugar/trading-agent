import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBuyEligibility } from '../server/services/eligibility.js';

// 默认门槛:最低股价 $2,最小市值 $3 亿,最低日均美元成交额 $500 万

test('大盘流动性充足的标的放行', () => {
  const r = checkBuyEligibility({
    profile: { marketCap: 5e9, averageVolume: 2e6 },
    price: 50,
  });
  assert.equal(r.ok, true);
});

test('仙股拦截(低于最低股价)', () => {
  const r = checkBuyEligibility({
    profile: { marketCap: 5e9, averageVolume: 1e7 },
    price: 1.5,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /股价/);
});

test('微盘拦截(低于最小市值)', () => {
  const r = checkBuyEligibility({
    profile: { marketCap: 100e6, averageVolume: 1e6 },
    price: 10,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /市值/);
});

test('低流动性拦截(日均美元成交额不足)', () => {
  // 10 万股 × $8 = $80 万/日 < $500 万
  const r = checkBuyEligibility({
    profile: { marketCap: 1e9, averageVolume: 1e5 },
    price: 8,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /成交额/);
});

test('档案缺失 fail-closed', () => {
  assert.equal(checkBuyEligibility({ profile: null, price: 50 }).ok, false);
  assert.equal(
    checkBuyEligibility({ profile: { averageVolume: 1e7 }, price: 50 }).ok,
    false,
    '市值缺失也拦截'
  );
});
