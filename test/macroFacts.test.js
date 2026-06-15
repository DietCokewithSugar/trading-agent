import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveEventKey,
  mintEventKey,
  classifyCalendarEventType,
  inflationSurpriseDirection,
  surpriseWeight,
  calendarFactTier,
  PERIODIC_EVENT_TYPES,
} from '../server/services/macroFacts.js';

// 美东午盘时刻,避开 UTC 日界换算歧义
const MAY = new Date('2026-05-12T15:30:00Z');

test('deriveEventKey:周期性数据按类型+美东年月,非周期返回 null', () => {
  assert.equal(deriveEventKey('CPI', MAY), 'CPI_2026-05');
  assert.equal(deriveEventKey('FOMC', MAY), 'FOMC_2026-05');
  assert.equal(deriveEventKey('NFP', MAY), 'NFP_2026-05');
  // 同月同类型 → 同键(去重的核心:一次发布只一行)
  assert.equal(deriveEventKey('CPI', new Date('2026-05-28T12:00:00Z')), 'CPI_2026-05');
  // 非周期事件没有确定性键,交给 LLM 判重
  assert.equal(deriveEventKey('geopolitics', MAY), null);
  assert.equal(deriveEventKey('tariffs', MAY), null);
  assert.equal(deriveEventKey('other', MAY), null);
  // 所有周期性类型都有键
  for (const t of PERIODIC_EVENT_TYPES) assert.ok(deriveEventKey(t, MAY), `${t} 应有确定性键`);
});

test('mintEventKey:类型_美东日_后缀,新闻ID 作后缀保证唯一可追溯', () => {
  assert.equal(mintEventKey('geopolitics', MAY, 123), 'geopolitics_2026-05-12_123');
  // 无 ID 时退回时间戳后缀(仍唯一)
  assert.match(mintEventKey('energy', MAY), /^energy_2026-05-12_/);
});

test('classifyCalendarEventType:识别周期性数据,其余 null', () => {
  assert.equal(classifyCalendarEventType('CPI (YoY)'), 'CPI');
  assert.equal(classifyCalendarEventType('Consumer Price Index'), 'CPI');
  assert.equal(classifyCalendarEventType('Core PCE Price Index'), 'PCE');
  assert.equal(classifyCalendarEventType('PPI (MoM)'), 'PPI');
  assert.equal(classifyCalendarEventType('Nonfarm Payrolls'), 'NFP');
  assert.equal(classifyCalendarEventType('GDP Growth Rate'), 'GDP');
  assert.equal(classifyCalendarEventType('Fed Interest Rate Decision'), 'FOMC');
  assert.equal(classifyCalendarEventType('FOMC Statement'), 'FOMC');
  assert.equal(classifyCalendarEventType('Housing Starts'), null);
  assert.equal(classifyCalendarEventType(''), null);
});

test('inflationSurpriseDirection:通胀/政策超预期=鹰派利空,低于预期=鸽派利好', () => {
  // CPI 高于预期 → 通胀上行、鹰派、利空风险资产(降息无望)
  const hot = inflationSurpriseDirection('CPI', 0.03);
  assert.equal(hot.macro_direction, 'risk_off');
  assert.equal(hot.rates_signal, 'hawkish');
  assert.equal(hot.inflation_signal, 'up');
  assert.equal(hot.surprise_direction, 'negative'); // 对股市是坏消息
  // CPI 低于预期 → 鸽派、利好
  const cool = inflationSurpriseDirection('CPI', -0.03);
  assert.equal(cool.macro_direction, 'risk_on');
  assert.equal(cool.rates_signal, 'dovish');
  assert.equal(cool.inflation_signal, 'down');
  // FOMC 利率高于预期 → 鹰派利空,但不直接标通胀
  const hawk = inflationSurpriseDirection('FOMC', 0.25);
  assert.equal(hawk.macro_direction, 'risk_off');
  assert.equal(hawk.inflation_signal, 'neutral');
  // 符合预期 → 中性 + inline
  const inline = inflationSurpriseDirection('CPI', 0);
  assert.equal(inline.macro_direction, 'neutral');
  assert.equal(inline.surprise_direction, 'inline');
});

test('inflationSurpriseDirection:增长类只标增长方向、不擅自定 risk 方向', () => {
  // 强非农 → 增长上行,但 risk 方向留给新闻解释(好数据 vs 担心 Fed 更鹰)
  const strong = inflationSurpriseDirection('NFP', 0.4);
  assert.equal(strong.macro_direction, 'neutral');
  assert.equal(strong.growth_signal, 'up');
  assert.equal(strong.surprise_direction, 'positive');
  const weak = inflationSurpriseDirection('GDP', -0.5);
  assert.equal(weak.macro_direction, 'neutral');
  assert.equal(weak.growth_signal, 'down');
  // 缺失意外 → 全中性
  assert.equal(inflationSurpriseDirection('CPI', undefined).macro_direction, 'neutral');
  assert.equal(inflationSurpriseDirection('CPI', NaN).surprise_direction, 'unknown');
});

test('surpriseWeight:超预期越多权重越大,符合预期略降,clamp [0.6,1.5],缺失为 1', () => {
  // 缺失意外 → 中性乘数 1(纯新闻事件 / 020 之前的行)
  assert.equal(surpriseWeight('CPI', undefined), 1);
  assert.equal(surpriseWeight('CPI', NaN), 1);
  // 符合预期(≈0)→ ~0.85(已被 price-in,冲击更小)
  assert.ok(surpriseWeight('CPI', 0) < 1);
  // 显著超预期 → 上探到 1.5
  assert.equal(surpriseWeight('CPI', 1), 1.5);
  // 单调:意外越大权重越大
  assert.ok(surpriseWeight('CPI', 0.05) > surpriseWeight('CPI', 0.01));
  // 方向无关,只看幅度
  assert.equal(surpriseWeight('CPI', 0.05), surpriseWeight('CPI', -0.05));
  // 仅有前值(无市场预期)时意外信号减半:更接近中性 1
  const withEstimate = surpriseWeight('CPI', 0.05, 'estimate');
  const withPrevious = surpriseWeight('CPI', 0.05, 'previous');
  assert.ok(Math.abs(withPrevious - 1) < Math.abs(withEstimate - 1));
});

test('calendarFactTier:全市场级数据给 1 档,其余 2 档,未知 3 档', () => {
  assert.equal(calendarFactTier('CPI'), 1);
  assert.equal(calendarFactTier('FOMC'), 1);
  assert.equal(calendarFactTier('NFP'), 1);
  assert.equal(calendarFactTier('PPI'), 2);
  assert.equal(calendarFactTier('GDP'), 2);
  assert.equal(calendarFactTier('geopolitics'), 3);
});
