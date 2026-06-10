import test from 'node:test';
import assert from 'node:assert/strict';
import { isHoliday, isEarlyClose, isTradingDay } from '../server/services/marketCalendar.js';

// 日历全部按规则计算,这里用已知年份的官方 NYSE 日历做基准校验。
// 一个算错的节假日 = 风控在交易日睡觉,或在休市日空转。

test('2025 年全天休市假日', () => {
  const holidays = [
    '2025-01-01', // 元旦
    '2025-01-20', // MLK 日
    '2025-02-17', // 总统日
    '2025-04-18', // 耶稣受难日(复活节 4/20 前的周五)
    '2025-05-26', // 阵亡将士纪念日
    '2025-06-19', // 六月节
    '2025-07-04', // 独立日
    '2025-09-01', // 劳工节
    '2025-11-27', // 感恩节
    '2025-12-25', // 圣诞节
  ];
  for (const d of holidays) {
    assert.equal(isHoliday(d), true, `${d} 应为休市日`);
    assert.equal(isTradingDay(d), false);
  }
});

test('2025 年 13:00 提前收市半日市', () => {
  for (const d of ['2025-07-03', '2025-11-28', '2025-12-24']) {
    assert.equal(isEarlyClose(d), true, `${d} 应为半日市`);
    assert.equal(isTradingDay(d), true, '半日市仍是交易日');
  }
});

test('2026 年:独立日落周六,观察日提前到 7/3,且 7/3 不再是半日市', () => {
  assert.equal(isHoliday('2026-07-03'), true);
  assert.equal(isHoliday('2026-07-04'), false, '周六本身不在假日表(本就非交易日)');
  assert.equal(isEarlyClose('2026-07-03'), false, '观察日全天休市,不应同时是半日市');
  assert.equal(isHoliday('2026-04-03'), true, '2026 耶稣受难日(复活节 4/5 前的周五)');
  assert.equal(isEarlyClose('2026-11-27'), true, '感恩节次日半日市');
});

test('2027 年:圣诞落周六,观察日 12/24,平安夜不再是半日市', () => {
  assert.equal(isHoliday('2027-12-24'), true);
  assert.equal(isEarlyClose('2027-12-24'), false);
  assert.equal(isHoliday('2027-07-05'), true, '2027 独立日落周日,顺延到周一');
});

test('普通交易日与周末', () => {
  assert.equal(isTradingDay('2026-06-10'), true, '普通周三');
  assert.equal(isTradingDay('2026-06-13'), false, '周六');
  assert.equal(isTradingDay('2026-06-14'), false, '周日');
  assert.equal(isTradingDay('bogus'), false, '畸形输入不抛错');
});
