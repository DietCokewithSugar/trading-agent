import test from 'node:test';
import assert from 'node:assert/strict';
import { spyHoldingReturn, etDateOf } from '../server/services/benchmark.js';

// 升序日线(隔过周末 06-13/06-14)
const ROWS = [
  { date: '2026-06-10', price: 100 },
  { date: '2026-06-11', price: 102 },
  { date: '2026-06-12', price: 101 },
  { date: '2026-06-15', price: 104 },
];

test('spyHoldingReturn:跨日持仓收盘对收盘', () => {
  assert.equal(
    spyHoldingReturn({ rows: ROWS, entryEtDate: '2026-06-10', exitEtDate: '2026-06-12' }),
    1
  );
  // 跨周末:出场日 06-14(周日)无收盘 → 用 ≤ 该日的最后收盘 06-12
  assert.equal(
    spyHoldingReturn({ rows: ROWS, entryEtDate: '2026-06-11', exitEtDate: '2026-06-14' }),
    Math.round((101 / 102 - 1) * 10000) / 100
  );
});

test('spyHoldingReturn:无跨度/缺数据返回 null', () => {
  // 同一有效收盘日(日内持仓):退化口径,交给调用方用当日涨跌近似
  assert.equal(
    spyHoldingReturn({ rows: ROWS, entryEtDate: '2026-06-11', exitEtDate: '2026-06-11' }),
    null
  );
  // 出场早于任何收盘
  assert.equal(
    spyHoldingReturn({ rows: ROWS, entryEtDate: '2026-06-01', exitEtDate: '2026-06-05' }),
    null
  );
  // 出场早于入场(脏数据)
  assert.equal(
    spyHoldingReturn({ rows: ROWS, entryEtDate: '2026-06-12', exitEtDate: '2026-06-10' }),
    null
  );
  assert.equal(spyHoldingReturn({ rows: [], entryEtDate: '2026-06-10', exitEtDate: '2026-06-12' }), null);
  assert.equal(spyHoldingReturn({}), null);
  // 非法价格行被跳过
  assert.equal(
    spyHoldingReturn({
      rows: [{ date: '2026-06-10', price: 0 }, { date: '2026-06-11', price: -1 }],
      entryEtDate: '2026-06-10',
      exitEtDate: '2026-06-11',
    }),
    null
  );
});

test('etDateOf:美东日历日,非法输入为 null', () => {
  // 美东晚 23:00(EDT,UTC-4)= UTC 次日 03:00,日历日仍是美东当天
  assert.equal(etDateOf('2026-06-12T03:00:00Z'), '2026-06-11');
  assert.equal(etDateOf('2026-06-11T13:00:00Z'), '2026-06-11');
  assert.equal(etDateOf('bogus'), null);
  assert.equal(etDateOf(null), null);
});
