import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySignal,
  pickExtreme,
  buildSignals,
  decideDcaTier,
  buildConclusion,
  smaLast,
  dropFromRecentHigh,
  percentileRank,
  monthlyAverages,
  vixMonthlySeries,
  DCA_TIERS,
} from '../server/services/valuationLogic.js';

// 与 config.valuationBoard 同形状的测试配置(阈值与看板设计一致)
const CFG = {
  vixTrigger: 30,
  fearGreedTrigger: 25,
  fearGreedCaution: 45,
  rsiTrigger: 22,
  rsiPeriod: 6,
  pePctTrigger: 20,
  peHighPct: 70,
  peExtremePct: 85,
  drawdownTrigger: -20,
  crashTrigger: -12,
  crashWindowDays: 25,
  nearRatio: 0.75,
};

test('classifySignal:above 方向(VIX)的三态与逼近带', () => {
  const base = { trigger: 30, direction: 'above', nearRatio: 0.75 };
  assert.equal(classifySignal({ value: 31, ...base }), 'triggered');
  assert.equal(classifySignal({ value: 30, ...base }), 'near', '恰在阈值不触发,落在逼近带');
  assert.equal(classifySignal({ value: 22.5, ...base }), 'near', '逼近带下沿 30×0.75');
  assert.equal(classifySignal({ value: 22.4, ...base }), 'idle');
  assert.equal(classifySignal({ value: null, ...base }), 'na');
});

test('classifySignal:below 方向正阈值(RSI/情绪/PE 分位)', () => {
  const base = { trigger: 22, direction: 'below', nearRatio: 0.75 };
  assert.equal(classifySignal({ value: 21.9, ...base }), 'triggered');
  assert.equal(classifySignal({ value: 22, ...base }), 'near', '正阈值触发为严格小于');
  assert.equal(classifySignal({ value: 29.3, ...base }), 'near', '逼近带上沿 22÷0.75≈29.33');
  assert.equal(classifySignal({ value: 29.4, ...base }), 'idle');
});

test('classifySignal:below 方向负阈值(回撤/急跌,含等号触发)', () => {
  const base = { trigger: -20, direction: 'below', nearRatio: 0.75 };
  assert.equal(classifySignal({ value: -20, ...base }), 'triggered', '≤ -20% 含等号');
  assert.equal(classifySignal({ value: -15, ...base }), 'near', '逼近带 -20×0.75 = -15');
  assert.equal(classifySignal({ value: -14.9, ...base }), 'idle');
});

test('pickExtreme:先比状态,同状态取离触发更近的一侧', () => {
  const near = { key: 'ndx', value: -9.31, state: 'near' };
  const idle = { key: 'spx', value: -2.64, state: 'idle' };
  assert.equal(pickExtreme([near, idle], 'below'), near);
  // 同状态(below)取更小值
  const a = { key: 'ndx', value: 47, state: 'idle' };
  const b = { key: 'spx', value: 64, state: 'idle' };
  assert.equal(pickExtreme([a, b], 'below'), a);
  // 全 na → null
  assert.equal(pickExtreme([{ key: 'ndx', value: null, state: 'na' }], 'below'), null);
});

// 参考看板截图 2026-07-29 的全套实值:六卡状态必须与截图一致
const SCREENSHOT_INPUTS = {
  vix: 18.21,
  fearGreed: 37,
  rsi: { ndx: 19.0, spx: 30.1 },
  pePct: { ndx: 47, spx: 64 },
  drawdown: { ndx: -10.74, spx: -3.22 },
  crash: { ndx: -9.31, spx: -2.64 },
};

test('buildSignals:截图实值夹具,六卡状态逐一吻合', () => {
  const signals = buildSignals(SCREENSHOT_INPUTS, CFG);
  const byKey = Object.fromEntries(signals.map((s) => [s.key, s]));
  assert.equal(signals.length, 6);
  assert.equal(byKey.vix.state, 'idle', 'VIX 18.21 未触发');
  assert.equal(byKey.fear_greed.state, 'idle', '恐贪 37 未触发');
  assert.equal(byKey.rsi.state, 'triggered', '纳指 RSI 19.0 < 22 触发');
  assert.equal(byKey.rsi.value, 19.0, '主值取触发一侧(纳指)');
  assert.equal(byKey.pe_percentile.state, 'idle', 'PE 分位 47%/64% 未触发');
  assert.equal(byKey.pe_percentile.value, 47, '主值取更低分位(纳指)');
  assert.equal(byKey.drawdown_52w.state, 'idle', '回撤 -10.74% 未触发');
  assert.equal(byKey.crash_25d.state, 'near', '纳指 25 日 -9.31% ≤ -9% 进入接近档');
  // 双指数子项完整
  assert.deepEqual(
    byKey.rsi.per_index.map((e) => e.key),
    ['ndx', 'spx']
  );
  assert.equal(byKey.rsi.per_index[1].state, 'idle', '标普 RSI 30.1 略高于逼近带');
});

test('buildSignals:数据缺失的卡片降级为 na,不影响其他卡', () => {
  const signals = buildSignals({ vix: 18, fearGreed: null, rsi: {}, pePct: {} }, CFG);
  const byKey = Object.fromEntries(signals.map((s) => [s.key, s]));
  assert.equal(byKey.vix.state, 'idle');
  assert.equal(byKey.fear_greed.state, 'na');
  assert.equal(byKey.rsi.state, 'na');
  assert.equal(byKey.pe_percentile.state, 'na');
  assert.equal(byKey.drawdown_52w.state, 'na');
});

test('decideDcaTier:任一触发 → 2×,优先级最高(估值极高也不压过)', () => {
  const signals = buildSignals(SCREENSHOT_INPUTS, CFG);
  const { multiplier, reason } = decideDcaTier({ signals, fearGreed: 37, pePct: 90 }, CFG);
  assert.equal(multiplier, 2);
  assert.match(reason, /RSI/);
});

test('decideDcaTier:接近或情绪谨慎 → 1.5×(截图当日口径)', () => {
  // 去掉触发项(RSI 拉回常态),保留 25 日急跌的接近档与恐贪 37 < 45
  const inputs = { ...SCREENSHOT_INPUTS, rsi: { ndx: 45, spx: 50 } };
  const signals = buildSignals(inputs, CFG);
  const { multiplier, reason } = decideDcaTier({ signals, fearGreed: 37, pePct: 64 }, CFG);
  assert.equal(multiplier, 1.5);
  assert.match(reason, /接近买入信号/);
  assert.match(reason, /情绪偏谨慎/);
  // 仅情绪谨慎、无接近信号也成立
  const calm = buildSignals({ vix: 15, fearGreed: 40, rsi: { ndx: 50, spx: 50 }, pePct: { ndx: 50, spx: 50 }, drawdown: { ndx: -3, spx: -2 }, crash: { ndx: -1, spx: -1 } }, CFG);
  assert.equal(decideDcaTier({ signals: calm, fearGreed: 40, pePct: 50 }, CFG).multiplier, 1.5);
});

test('decideDcaTier:估值降档与默认档;PE 缺失时静默跳过降档', () => {
  const calmInputs = {
    vix: 15,
    fearGreed: 60,
    rsi: { ndx: 50, spx: 55 },
    pePct: { ndx: 90, spx: 88 },
    drawdown: { ndx: -3, spx: -2 },
    crash: { ndx: -1, spx: -1 },
  };
  const signals = buildSignals(calmInputs, CFG);
  assert.equal(decideDcaTier({ signals, fearGreed: 60, pePct: 90 }, CFG).multiplier, 0.25);
  assert.equal(decideDcaTier({ signals, fearGreed: 60, pePct: 75 }, CFG).multiplier, 0.5);
  assert.equal(decideDcaTier({ signals, fearGreed: 60, pePct: 50 }, CFG).multiplier, 1);
  const noPe = decideDcaTier({ signals, fearGreed: 60, pePct: null }, CFG);
  assert.equal(noPe.multiplier, 1);
  assert.match(noPe.reason, /暂无数据/);
});

test('DCA_TIERS:五档定义完整且倍数升序', () => {
  assert.deepEqual(
    DCA_TIERS.map((t) => t.multiplier),
    [0.25, 0.5, 1, 1.5, 2]
  );
  for (const t of DCA_TIERS) assert.ok(t.label);
});

test('buildConclusion:四行文案与截图口径对齐', () => {
  const c = buildConclusion({
    pe: { ndx: 47, spx: 64 },
    fearGreed: 37,
    vix: 18.21,
    trendGap: { ndx: 3.7, spx: 2.1 },
    multiplier: 1.5,
  });
  assert.match(c.valuation, /正常/);
  assert.match(c.valuation, /47%/);
  assert.match(c.sentiment, /恐惧/);
  assert.match(c.sentiment, /VIX 18\.21/);
  assert.match(c.trend, /上升趋势/);
  assert.match(c.trend, /\+3\.7%/);
  assert.match(c.advice, /1\.5 倍/);
});

test('buildConclusion:输入缺失逐行降级,不抛错', () => {
  const c = buildConclusion({});
  assert.match(c.valuation, /暂无数据/);
  assert.match(c.sentiment, /暂无数据/);
  assert.equal(c.trend, '暂无数据');
  assert.ok(c.advice);
  // 趋势分化与跌破口径
  assert.match(
    buildConclusion({ trendGap: { ndx: 2, spx: -1 } }).trend,
    /分化/
  );
  assert.match(
    buildConclusion({ trendGap: { ndx: -2, spx: -1 } }).trend,
    /跌破/
  );
});

test('smaLast / dropFromRecentHigh / percentileRank:边界行为', () => {
  assert.equal(smaLast([1, 2, 3, 4], 2), 3.5);
  assert.equal(smaLast([1, 2], 3), null);
  // 25 日急跌:末端 n 窗口内高点 → 现值
  assert.equal(dropFromRecentHigh([100, 110, 99], 3), -10);
  assert.equal(dropFromRecentHigh([100, 110, 99], 2), -10, '窗口取末尾 n 个');
  assert.equal(dropFromRecentHigh([], 5), null);
  assert.equal(percentileRank([10, 20, 30, 40], 30), 75);
  assert.equal(percentileRank([], 1), null);
});

test('monthlyAverages / vixMonthlySeries:按月聚合与分位', () => {
  const rows = [
    { date: '2026-05-02', price: 20 },
    { date: '2026-05-15', price: 30 },
    { date: '2026-06-01', price: 10 },
    { date: '2026-07-01', price: 40 },
  ];
  assert.deepEqual(monthlyAverages(rows), [
    { month: '2026-05', avg: 25 },
    { month: '2026-06', avg: 10 },
    { month: '2026-07', avg: 40 },
  ]);
  const series = vixMonthlySeries(rows, 2);
  assert.equal(series.length, 2);
  assert.deepEqual(series[0], { month: '2026-06', vix_avg: 10, vix_pct: 33 });
  assert.deepEqual(series[1], { month: '2026-07', vix_avg: 40, vix_pct: 100 });
  assert.deepEqual(vixMonthlySeries([], 6), []);
});
