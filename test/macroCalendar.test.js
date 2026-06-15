import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSurprise,
  parseCalendarDate,
  filterHighImportanceUs,
  isInBlackout,
  calendarFactEligible,
} from '../server/services/macroCalendar.js';

test('computeSurprise:优先 estimate,缺失退回 previous,皆缺返回 null', () => {
  assert.deepEqual(computeSurprise({ actual: 3.3, estimate: 3.0 }), {
    surprise: 0.1,
    basis: 'estimate',
  });
  assert.deepEqual(computeSurprise({ actual: 2.5, previous: 2.0 }), {
    surprise: 0.25,
    basis: 'previous',
  });
  // estimate 存在时不看 previous
  assert.equal(computeSurprise({ actual: 3.0, estimate: 3.0, previous: 1.0 }).surprise, 0);
  assert.equal(computeSurprise({ actual: 3.0 }), null);
  assert.equal(computeSurprise({ estimate: 3.0, previous: 2.0 }), null, 'actual 缺失');
  assert.equal(computeSurprise({}), null);
});

test('computeSurprise:负基准取绝对值、零基准退化为绝对差', () => {
  // -2 → -1:相对 |−2| 改善 50%
  assert.equal(computeSurprise({ actual: -1, estimate: -2 }).surprise, 0.5);
  // 基准 0(利率类数据):除零无意义,退化为绝对差
  assert.equal(computeSurprise({ actual: 0.25, estimate: 0 }).surprise, 0.25);
});

test('parseCalendarDate:UTC 裸时间戳与带时区字符串均可解析', () => {
  assert.equal(parseCalendarDate('2026-06-11 12:30:00'), Date.parse('2026-06-11T12:30:00Z'));
  assert.equal(parseCalendarDate('2026-06-11T12:30:00Z'), Date.parse('2026-06-11T12:30:00Z'));
  assert.equal(parseCalendarDate(''), null);
  assert.equal(parseCalendarDate('not-a-date'), null);
});

test('filterHighImportanceUs:只留美国高重要性,impact/importance 两种字段名兼容', () => {
  const rows = [
    { country: 'US', impact: 'High', event: 'CPI' },
    { country: 'US', importance: 'high', event: 'NFP' },
    { country: 'US', impact: 'Medium', event: 'Building Permits' },
    { country: 'DE', impact: 'High', event: 'German CPI' },
    null,
  ];
  assert.deepEqual(
    filterHighImportanceUs(rows).map((r) => r.event),
    ['CPI', 'NFP']
  );
  assert.deepEqual(filterHighImportanceUs(null), []);
});

test('isInBlackout:窗前/窗中/窗后边界', () => {
  const events = [{ date: '2026-06-11 12:30:00', event: 'CPI' }];
  const opts = { beforeMinutes: 30, afterMinutes: 30 };
  const at = (s) => new Date(`2026-06-11T${s}Z`);
  assert.equal(isInBlackout(at('11:59:59'), events, opts).inBlackout, false, '窗前 1 秒');
  assert.equal(isInBlackout(at('12:00:00'), events, opts).inBlackout, true, '窗口起点');
  assert.equal(isInBlackout(at('12:30:00'), events, opts).inBlackout, true, '发布时刻');
  const inWin = isInBlackout(at('12:59:59'), events, opts);
  assert.equal(inWin.inBlackout, true, '窗口终点前');
  assert.equal(inWin.until, '2026-06-11T13:00:00.000Z');
  assert.equal(isInBlackout(at('13:00:01'), events, opts).inBlackout, false, '窗后 1 秒');
});

test('isInBlackout:空事件/无效日期/窗口为 0 时恒不在黑窗', () => {
  const now = new Date('2026-06-11T12:30:00Z');
  assert.equal(isInBlackout(now, [], { beforeMinutes: 30, afterMinutes: 30 }).inBlackout, false);
  assert.equal(
    isInBlackout(now, [{ date: 'bogus' }], { beforeMinutes: 30, afterMinutes: 30 }).inBlackout,
    false
  );
  assert.equal(
    isInBlackout(now, [{ date: '2026-06-11 12:30:00' }], { beforeMinutes: 0, afterMinutes: 0 })
      .inBlackout,
    false,
    '窗口为 0 = 关闭'
  );
});

test('isInBlackout:多事件重叠取最晚结束的窗口', () => {
  const events = [
    { date: '2026-06-11 12:30:00', event: 'CPI' },
    { date: '2026-06-11 13:00:00', event: 'FOMC' },
  ];
  const hit = isInBlackout(new Date('2026-06-11T12:45:00Z'), events, {
    beforeMinutes: 30,
    afterMinutes: 30,
  });
  assert.equal(hit.inBlackout, true);
  assert.equal(hit.event.event, 'FOMC', '两个窗口都命中时取结束更晚的');
  assert.equal(hit.until, '2026-06-11T13:30:00.000Z');
});

test('calendarFactEligible:未发布(null/空 actual)不建事实——防止 Number(null)=0 造假', () => {
  const past = '2026-06-10 12:30:00'; // 已过去
  const future = '2026-12-10 18:00:00'; // 未到点
  const now = new Date('2026-06-15T00:00:00Z');
  // 回归 bug:未发布的 FOMC(actual 缺失/null/空)曾被 Number() 当成 0 → 意外 -100% → 误判 risk_on
  assert.equal(calendarFactEligible({ event: 'Fed Interest Rate Decision', date: future, estimate: 3.75 }, now), false, '未到发布时刻');
  assert.equal(calendarFactEligible({ event: 'CPI', date: past, actual: null, estimate: 3 }, now), false, 'actual=null');
  assert.equal(calendarFactEligible({ event: 'CPI', date: past, actual: '', estimate: 3 }, now), false, 'actual=空串');
  assert.equal(calendarFactEligible({ event: 'CPI', date: past, estimate: 3 }, now), false, 'actual 缺失');
  assert.equal(calendarFactEligible({ event: 'CPI', date: past, actual: 'n/a', estimate: 3 }, now), false, 'actual 非数值');
  // 已发布且 actual 为真实数值(含真实的 0)→ 可建
  assert.equal(calendarFactEligible({ event: 'CPI', date: past, actual: 3.2, estimate: 3 }, now), true);
  assert.equal(calendarFactEligible({ event: 'GDP', date: past, actual: 0, estimate: 0.3 }, now), true, '真实的 0 是有效实际值');
  // 已发布但日期无法解析 → 不建
  assert.equal(calendarFactEligible({ event: 'CPI', date: 'bad', actual: 3.2 }, now), false);
});
