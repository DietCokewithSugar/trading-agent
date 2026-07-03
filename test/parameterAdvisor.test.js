import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateSignalRules,
  evaluateShadowRules,
  evaluateOutcomeRules,
  subsetMetrics,
  withAdjustedReturns,
  ADVISOR_THRESHOLDS,
} from '../server/services/parameterAdvisor.js';

const cfg = {
  minFinalConfidence: 0.35,
  pressBullishPenalty: 0.75,
  maxAllocationsPerRun: 3,
  conflictWindowMinutes: 120,
  stopLossPercent: 2,
  takeProfitPercent: 2,
};

function rows(n, overrides) {
  return Array.from({ length: n }, () => ({
    sentiment: 'bullish',
    tier: 1,
    confidence: 0.8,
    final_confidence: 0.6,
    source_score: 0.9,
    is_press: false,
    traded: false,
    candidate_status: null,
    officer_veto: false,
    fwd_return_1h: null,
    fwd_return_1d: null,
    fwd_return_5d: null,
    ...overrides,
  }));
}

test('subsetMetrics:方向调整后的均值/命中率/区间', () => {
  const enriched = withAdjustedReturns([
    ...rows(2, { fwd_return_1d: 1 }),
    ...rows(1, { sentiment: 'bearish', fwd_return_1d: -2 }), // 方向调整后 +2
    ...rows(1, { fwd_return_1d: -1 }),
  ]);
  const m = subsetMetrics(enriched);
  assert.equal(m.n, 4);
  assert.equal(m.mean, 0.75); // (1+1+2-1)/4
  assert.equal(m.hit, 75);
  assert.ok(m.hitLo < 75 && m.hitHi > 75);
});

test('低可信来源利好收益为负 → 建议提高 MIN_FINAL_CONFIDENCE;样本不足保持沉默', () => {
  const bad = rows(ADVISOR_THRESHOLDS.minSamples, { source_score: 0.5, fwd_return_1d: -1 });
  const { suggestions } = evaluateSignalRules(bad, cfg);
  const hit = suggestions.find((s) => s.id === 'low_source_bullish');
  assert.equal(hit.level, 'adjust');
  assert.match(hit.suggestion, /0\.35 → 0\.4/);

  const few = rows(ADVISOR_THRESHOLDS.minSamples - 1, { source_score: 0.5, fwd_return_1d: -1 });
  const result = evaluateSignalRules(few, cfg);
  assert.equal(result.suggestions.find((s) => s.id === 'low_source_bullish'), undefined);
  assert.ok(result.skipped.some((s) => s.id === 'low_source_bullish'));
});

test('新闻稿利好命中率显著低于 50% → 建议加大 PRESS_BULLISH_PENALTY 折价', () => {
  const press = rows(40, { is_press: true, fwd_return_1d: -1 });
  const { suggestions } = evaluateSignalRules(press, cfg);
  const hit = suggestions.find((s) => s.id === 'press_bullish');
  assert.equal(hit.level, 'adjust');
  assert.match(hit.suggestion, /0\.75 → 0\.55/);
});

test('第 2 档 1d 命中率显著高于第 1 档(区间不重叠)→ 档位校准建议', () => {
  const data = [
    ...rows(40, { tier: 1, fwd_return_1d: -1 }),
    ...rows(40, { tier: 2, fwd_return_1d: 1 }),
  ];
  const { suggestions } = evaluateSignalRules(data, cfg);
  assert.equal(suggestions.find((s) => s.id === 'tier_inversion')?.level, 'adjust');

  // 排序正常时不出结论
  const normal = [
    ...rows(40, { tier: 1, fwd_return_1d: 1 }),
    ...rows(40, { tier: 2, fwd_return_1d: -1 }),
  ];
  const r2 = evaluateSignalRules(normal, cfg);
  assert.equal(r2.suggestions.find((s) => s.id === 'tier_inversion'), undefined);
});

// ── 实盘兑现规则(±2%/48h 策略口径)──

function outcomeRows(n, overrides) {
  return Array.from({ length: n }, () => ({
    trigger: 'take_profit',
    realized_pnl: 10,
    tier: 1,
    source_score: 0.9,
    is_press: false,
    ...overrides,
  }));
}

test('实盘兑现:止损占比过半 → adjust,止盈占比过半 → ok', () => {
  const stopped = [
    ...outcomeRows(20, { trigger: 'stop_loss', realized_pnl: -10 }),
    ...outcomeRows(10, { trigger: 'take_profit' }),
  ];
  const r1 = evaluateOutcomeRules(stopped, cfg);
  assert.equal(r1.suggestions.find((s) => s.id === 'outcome_stop_share')?.level, 'adjust');

  const profited = [
    ...outcomeRows(20, { trigger: 'take_profit' }),
    ...outcomeRows(10, { trigger: 'stop_loss', realized_pnl: -10 }),
  ];
  const r2 = evaluateOutcomeRules(profited, cfg);
  assert.equal(r2.suggestions.find((s) => s.id === 'outcome_stop_share')?.level, 'ok');
});

test('实盘兑现:样本不足或占比未过半时沉默', () => {
  const few = outcomeRows(10, { trigger: 'stop_loss' });
  const r1 = evaluateOutcomeRules(few, cfg);
  assert.equal(r1.suggestions.length, 0);
  assert.ok(r1.skipped.find((s) => s.id === 'outcome_stop_share'));

  // 三方分布均未过半:不下结论
  const mixed = [
    ...outcomeRows(15, { trigger: 'take_profit' }),
    ...outcomeRows(15, { trigger: 'stop_loss', realized_pnl: -10 }),
    ...outcomeRows(10, { trigger: 'max_hold', realized_pnl: 1 }),
  ];
  const r2 = evaluateOutcomeRules(mixed, cfg);
  assert.equal(r2.suggestions.find((s) => s.id === 'outcome_stop_share'), undefined);
});

test('实盘兑现:低可信来源止损占比过半 → 提高门槛建议', () => {
  const data = [
    ...outcomeRows(25, { trigger: 'stop_loss', realized_pnl: -5, source_score: 0.5 }),
    ...outcomeRows(10, { trigger: 'take_profit', source_score: 0.5 }),
    ...outcomeRows(40, { trigger: 'take_profit', source_score: 0.95 }),
  ];
  const { suggestions } = evaluateOutcomeRules(data, cfg);
  assert.equal(suggestions.find((s) => s.id === 'outcome_low_source')?.level, 'adjust');
});

test('拦截层机会成本:被拦信号上涨 → adjust,下跌 → ok(确认价值)', () => {
  const up = rows(ADVISOR_THRESHOLDS.minSamplesBlocked, {
    candidate_status: 'macro_filtered',
    fwd_return_1d: 1,
  });
  assert.equal(
    evaluateSignalRules(up, cfg).suggestions.find((s) => s.id === 'macro_filter_cost')?.level,
    'adjust'
  );
  const down = rows(ADVISOR_THRESHOLDS.minSamplesBlocked, {
    candidate_status: 'macro_filtered',
    fwd_return_1d: -1,
  });
  assert.equal(
    evaluateSignalRules(down, cfg).suggestions.find((s) => s.id === 'macro_filter_cost')?.level,
    'ok'
  );
  // 风控官否决桶用更低的样本门槛
  const veto = rows(ADVISOR_THRESHOLDS.minSamplesVeto, { officer_veto: true, fwd_return_1d: -1 });
  assert.equal(
    evaluateSignalRules(veto, cfg).suggestions.find((s) => s.id === 'officer_veto_value')?.level,
    'ok'
  );
});

test('置信度校准倒挂(高置信桶显著差于低置信桶)→ adjust', () => {
  const data = [
    ...rows(25, { confidence: 0.55, fwd_return_1d: 1 }),
    ...rows(25, { confidence: 0.75, fwd_return_1d: 1 }),
    ...rows(25, { confidence: 0.95, fwd_return_1d: -1 }),
  ];
  const { suggestions } = evaluateSignalRules(data, cfg);
  assert.equal(suggestions.find((s) => s.id === 'confidence_calibration')?.level, 'adjust');
});

test('影子组合对照:显著跑赢 → adjust,显著跑输 → ok,样本期不足/差异小 → 沉默', () => {
  const now = Date.now();
  const started = new Date(now - 30 * 86400_000).toISOString();
  // 对照口径是同窗收益 window_return_pct;自建立累计的 pnl_percent 不参与判定
  const mk = (winPct) => [
    { variant: 'no_macro_filter', started_at: started, pnl_percent: 99, window_return_pct: winPct },
  ];

  const win = evaluateShadowRules({ variants: mk(8), actualReturnPct: 3, now });
  assert.equal(win.suggestions.find((s) => s.id === 'shadow_no_macro_filter')?.level, 'adjust');

  const lose = evaluateShadowRules({ variants: mk(-2), actualReturnPct: 3, now });
  assert.equal(lose.suggestions.find((s) => s.id === 'shadow_no_macro_filter')?.level, 'ok');

  const flat = evaluateShadowRules({ variants: mk(4), actualReturnPct: 3, now });
  assert.equal(flat.suggestions.length, 0);

  const young = evaluateShadowRules({
    variants: [
      {
        variant: 'no_macro_filter',
        started_at: new Date(now - 3 * 86400_000).toISOString(),
        window_return_pct: 9,
      },
    ],
    actualReturnPct: 0,
    now,
  });
  assert.equal(young.suggestions.length, 0);
  assert.ok(young.skipped.some((s) => s.id === 'shadow_no_macro_filter'));

  // 窗口序列不足(无 window_return_pct)→ 沉默跳过,不退回自建立累计口径
  const noWindow = evaluateShadowRules({
    variants: [{ variant: 'no_macro_filter', started_at: started, pnl_percent: 9 }],
    actualReturnPct: 0,
    now,
  });
  assert.equal(noWindow.suggestions.length, 0);
  assert.ok(noWindow.skipped.some((s) => s.id === 'shadow_no_macro_filter'));

  const noData = evaluateShadowRules({ variants: null, actualReturnPct: null });
  assert.equal(noData.suggestions.length, 0);
});

test('出场消融变体对照(023):三个变体各有方向性建议,vol_bracket 指向管理页开关', () => {
  const now = Date.now();
  const started = new Date(now - 30 * 86400_000).toISOString();
  const mk = (variant, winPct) => [{ variant, started_at: started, window_return_pct: winPct }];

  const wide = evaluateShadowRules({ variants: mk('wide_bracket', 8), actualReturnPct: 3, now });
  const wideAdj = wide.suggestions.find((s) => s.id === 'shadow_wide_bracket');
  assert.equal(wideAdj?.level, 'adjust');
  assert.ok(/STOP_LOSS_PERCENT|BRACKET_MAX_PERCENT/.test(wideAdj.suggestion), '建议指向敞口/时限参数');

  const trail = evaluateShadowRules({ variants: mk('trailing_only', 8), actualReturnPct: 3, now });
  const trailAdj = trail.suggestions.find((s) => s.id === 'shadow_trailing_only');
  assert.equal(trailAdj?.level, 'adjust');
  assert.ok(/ENABLE_TRAILING_STOP/.test(trailAdj.suggestion), '建议指向移动止损');

  const vol = evaluateShadowRules({ variants: mk('vol_bracket', 8), actualReturnPct: 3, now });
  const volAdj = vol.suggestions.find((s) => s.id === 'shadow_vol_bracket');
  assert.equal(volAdj?.level, 'adjust');
  assert.ok(/管理员页/.test(volAdj.suggestion), 'vol_bracket 建议指向管理员页运行时开关');

  const volLose = evaluateShadowRules({ variants: mk('vol_bracket', -2), actualReturnPct: 3, now });
  assert.equal(volLose.suggestions.find((s) => s.id === 'shadow_vol_bracket')?.level, 'ok');
});

test('实盘兑现规则:波动自适应模式下止损占比建议改指 BRACKET_* 参数', () => {
  const stopped = Array.from({ length: 30 }, () => ({ trigger: 'stop_loss', source_score: 0.9 }));
  const volCfg = { ...cfg, volBracketEnabled: true, bracketVolK: 1, bracketMinPercent: 1.5, bracketMaxPercent: 4 };
  const r = evaluateOutcomeRules(stopped, volCfg);
  const s = r.suggestions.find((x) => x.id === 'outcome_stop_share');
  assert.equal(s?.level, 'adjust');
  assert.ok(/BRACKET_MAX_PERCENT|BRACKET_VOL_K/.test(s.suggestion), 'vol 模式指向 BRACKET_* 参数');
  assert.ok(!/STOP_LOSS_PERCENT/.test(s.suggestion), '不再指向固定百分比参数');
});
