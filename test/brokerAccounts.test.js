import test from 'node:test';
import assert from 'node:assert/strict';
import { maskKeyId, validateAccountInput } from '../server/services/brokerAccounts.js';

test('maskKeyId:保留前 2 + 后 4,中间打码;短 key 整体打码;空值返回空串', () => {
  assert.equal(maskKeyId('PKABCDEFGHIJ1234'), 'PK****1234');
  assert.equal(maskKeyId('ABCDEF'), '****', '长度 ≤6 整体打码');
  assert.equal(maskKeyId(''), '');
  assert.equal(maskKeyId(null), '');
});

test('validateAccountInput:必填校验与错误聚合', () => {
  assert.deepEqual(
    validateAccountInput({ name: '实验账户', keyId: 'PK1', secretKey: 'SK1' }),
    []
  );
  const errors = validateAccountInput({ name: '', keyId: '', secretKey: '' });
  assert.equal(errors.length, 3, '名称/KeyID/Secret 三项必填各报一条');
});

test('validateAccountInput:base_url 只接受 https(密钥随请求头发送,明文端点等于泄露)', () => {
  assert.deepEqual(
    validateAccountInput({ name: 'a', keyId: 'k', secretKey: 's', baseUrl: 'https://mock.example.com' }),
    []
  );
  assert.equal(
    validateAccountInput({ name: 'a', keyId: 'k', secretKey: 's', baseUrl: 'http://mock.example.com' }).length,
    1
  );
  assert.equal(
    validateAccountInput({ name: 'a', keyId: 'k', secretKey: 's', baseUrl: '不是网址' }).length,
    1
  );
});

test('validateAccountInput:本地回环地址放行 http(本地联调/模拟端点)', () => {
  assert.deepEqual(
    validateAccountInput({ name: 'a', keyId: 'k', secretKey: 's', baseUrl: 'http://localhost:4568' }),
    []
  );
  assert.deepEqual(
    validateAccountInput({ name: 'a', keyId: 'k', secretKey: 's', baseUrl: 'http://127.0.0.1:4568' }),
    []
  );
});

test('validateAccountInput:名称长度上限 50', () => {
  assert.equal(
    validateAccountInput({ name: 'x'.repeat(51), keyId: 'k', secretKey: 's' }).length,
    1
  );
});
