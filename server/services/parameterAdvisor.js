// 参数建议器(评估清单第 5 项):把评估层的统计反过来映射成参数调整建议,
// 而不是只展示统计——"低可信来源利好 1d 平均收益为负 → 提高门槛/只入池不交易"、
// "被宏观过滤的信号持续上涨 → 宏观层过度保守"、"新闻稿利好命中率低 → 加大折价"。
//
// 设计原则:
//  - 纯确定性规则(无 LLM):每条建议都带样本量、均值、命中率与 95% 置信区间证据;
//  - 小样本不出建议:每条规则有最小样本门槛,命中率类判断要求置信区间整体越过 50%,
//    与「信号质量」页的着色口径一致——统计不显著时宁可沉默;
//  - 只建议、不自动改参:参数变更仍由人通过环境变量决定,建议文案给出具体的
//    当前值 → 建议值;
//  - 上半部为纯函数(node:test 直接测),数据装配在 getParameterAdvice。
import { config } from '../config.js';
import { supabase } from '../db.js';
import { loadSignalRows, wilsonInterval } from './signalStats.js';
import { getShadowOverview } from './shadowPortfolio.js';
import { isVolBracketEnabled } from './volBracket.js';

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** 规则阈值(集中导出,测试与文档同源) */
export const ADVISOR_THRESHOLDS = {
  minSamples: 30, // 来源/新闻稿/档位/置信度类规则的最小样本(单桶)
  minSamplesBlocked: 20, // 拦截层机会成本类规则的最小样本
  minSamplesVeto: 15, // 风控官否决样本天然更少,门槛略低
  edgePercent: 0.3, // 平均方向收益的最小可操作幅度(百分点)
  shadowMinDays: 14, // 影子组合对照的最短运行天数
  shadowEdgePercent: 2, // 影子组合与实盘的最小净值差(百分点)
  minSamplesOutcome: 30, // 实盘兑现类规则的最小平仓样本
  stopShareHighPercent: 55, // 止损/止盈占比的"显著占优"阈值(百分比)
};

/** 子集在某口径上的样本量/均值/命中率/区间(rows 需已带 adj_* 字段) */
export function subsetMetrics(rows, horizon = '1d') {
  const adj = (rows || [])
    .map((r) => r[`adj_${horizon}`])
    .filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  const hits = adj.filter((v) => v > 0).length;
  const ci = wilsonInterval(hits, adj.length);
  return {
    n: adj.length,
    mean: adj.length ? round(adj.reduce((a, b) => a + b, 0) / adj.length, 3) : null,
    hit: adj.length ? round((hits / adj.length) * 100, 1) : null,
    hitLo: ci ? ci.lo : null,
    hitHi: ci ? ci.hi : null,
  };
}

/** 方向调整收益预计算(与 signalStats.summarizeSignals 同口径) */
export function withAdjustedReturns(rows) {
  return (rows || []).map((r) => {
    const dir = r.sentiment === 'bearish' ? -1 : 1;
    const adj = (v) =>
      v === null || v === undefined || !Number.isFinite(Number(v)) ? null : dir * Number(v);
    return {
      ...r,
      adj_1h: adj(r.fwd_return_1h),
      adj_1d: adj(r.fwd_return_1d),
      adj_5d: adj(r.fwd_return_5d),
    };
  });
}

function evidenceText(m, horizon = '1d') {
  return `样本 ${m.n},${horizon} 平均方向收益 ${m.mean >= 0 ? '+' : ''}${m.mean}%,命中率 ${m.hit}%(95% 区间 ${m.hitLo}~${m.hitHi}%)`;
}

/**
 * 信号统计规则(纯函数):rows 为 loadSignalRows 的行,cfg 为参数快照。
 * 返回 { suggestions: [{ id, level: adjust|ok, title, evidence, suggestion }], skipped: [...] }。
 * level=adjust 表示建议调参,level=ok 表示该层正在创造价值(确认性结论)。
 */
export function evaluateSignalRules(rawRows, cfg, t = ADVISOR_THRESHOLDS) {
  const rows = withAdjustedReturns(rawRows);
  const suggestions = [];
  const skipped = [];
  const skip = (id, title, m) =>
    skipped.push({ id, title, reason: `样本不足(${m.n} < 门槛)或统计不显著` });

  // 1. 低可信来源利好:负收益 → 提高综合置信度门槛/只入池不交易
  {
    const subset = rows.filter(
      (r) => r.sentiment === 'bullish' && r.source_score !== null && r.source_score < 0.65
    );
    const m = subsetMetrics(subset);
    const title = '低可信来源(<0.65)的利好信号';
    if (m.n >= t.minSamples && m.mean !== null && m.mean <= -t.edgePercent) {
      suggestions.push({
        id: 'low_source_bullish',
        level: 'adjust',
        title,
        evidence: evidenceText(m),
        suggestion: `低可信来源利好的前瞻收益为负,建议提高综合置信度门槛 MIN_FINAL_CONFIDENCE(当前 ${cfg.minFinalConfidence} → ${Math.min(round(cfg.minFinalConfidence + 0.05), 0.6)}),让更多低可信信号挂起等交叉确认而非直接入池。`,
      });
    } else if (m.n >= t.minSamples && m.mean !== null && m.mean >= t.edgePercent) {
      suggestions.push({
        id: 'low_source_bullish',
        level: 'ok',
        title,
        evidence: evidenceText(m),
        suggestion: '低可信来源利好整体仍有正收益,当前来源折价与门槛未表现出过度保守。',
      });
    } else {
      skip('low_source_bullish', title, m);
    }
  }

  // 2. 新闻稿利好:命中率显著低于 50% → 加大 PRESS_BULLISH_PENALTY 折价
  {
    const subset = rows.filter((r) => r.sentiment === 'bullish' && r.is_press);
    const m = subsetMetrics(subset);
    const title = '公司公告/新闻稿渠道的利好信号';
    if (m.n >= t.minSamples && m.hitHi !== null && m.hitHi < 50) {
      const suggested = Math.max(0.5, round(cfg.pressBullishPenalty - 0.2));
      suggestions.push({
        id: 'press_bullish',
        level: 'adjust',
        title,
        evidence: evidenceText(m),
        suggestion: `新闻稿利好的命中率显著低于 50%,建议加大公告折价 PRESS_BULLISH_PENALTY(当前 ${cfg.pressBullishPenalty} → ${suggested}),让更多公告利好落入挂起等独立信源确认的流程。`,
      });
    } else if (m.n >= t.minSamples && m.hitLo !== null && m.hitLo > 50) {
      suggestions.push({
        id: 'press_bullish',
        level: 'ok',
        title,
        evidence: evidenceText(m),
        suggestion: '新闻稿利好命中率显著高于 50%,当前折价幅度没有表现出过松。',
      });
    } else {
      skip('press_bullish', title, m);
    }
  }

  // 3. 档位校准:第 2 档 1d 命中率显著高于第 1 档 → 分档定义/LLM 校准需复核。
  // 口径用 1d 而非 5d:±2%/48h 策略下 1d 是决策口径,5d 已降级为研究口径且样本最稀疏
  {
    const m1 = subsetMetrics(rows.filter((r) => r.tier === 1), '1d');
    const m2 = subsetMetrics(rows.filter((r) => r.tier === 2), '1d');
    const title = '事件档位的收益排序(第 1 档 vs 第 2 档,1 个交易日)';
    if (m1.n >= t.minSamples && m2.n >= t.minSamples && m2.hitLo !== null && m1.hitHi !== null && m2.hitLo > m1.hitHi) {
      suggestions.push({
        id: 'tier_inversion',
        level: 'adjust',
        title,
        evidence: `第 1 档:${evidenceText(m1, '1d')};第 2 档:${evidenceText(m2, '1d')}`,
        suggestion:
          '第 2 档命中率显著高于第 1 档(置信区间不重叠),档位定义或分析师的影响程度/范围判定可能需要重新校准——复核 computeTier 规则与 analyst prompt 的分档措辞,或检视第 1 档是否被"已定价的大新闻"污染。',
      });
    } else if (m1.n >= t.minSamples && m2.n >= t.minSamples) {
      // 排序正常或差异不显著:不出结论(避免反向噪音)
      skipped.push({ id: 'tier_inversion', title, reason: '档位排序未出现显著倒挂' });
    } else {
      skip('tier_inversion', title, m1.n < t.minSamples ? m1 : m2);
    }
  }

  // 4/5/6. 拦截层机会成本:被拦信号持续上涨 → 过度保守;持续下跌 → 该层在创造价值
  const blockedRules = [
    {
      id: 'macro_filter_cost',
      title: '宏观过滤拦下的信号',
      match: (r) => !r.traded && r.candidate_status === 'macro_filtered',
      minN: t.minSamplesBlocked,
      adjustText: () =>
        '被宏观过滤的信号平均仍在上涨,宏观层可能过度拦截——考虑放宽 risk_off 的允许档位/置信度(config.macroRegimeParams),并与「消融实验」页 no_macro_filter 变体的净值对照确认。',
      okText: () => '被宏观过滤的信号平均在下跌,宏观层正在创造价值。',
    },
    {
      id: 'officer_veto_value',
      title: '风控官否决的信号(分配路径)',
      match: (r) => !r.traded && r.officer_veto,
      minN: t.minSamplesVeto,
      adjustText: () =>
        '被风控官否决的信号平均仍在上涨,风控官可能过度保守——复核 risk-officer prompt 的否决条款(prompt 修改记得给 PROMPT_VERSIONS +1),并与 no_risk_officer 影子组合净值对照。',
      okText: () => '被风控官否决的信号平均在下跌,风控官的否决正在创造价值。',
    },
    {
      id: 'capital_constrained_cost',
      title: '资金受限未成交的信号',
      match: (r) => !r.traded && r.candidate_status === 'capital_constrained',
      minN: t.minSamplesBlocked,
      adjustText: (cfg2) =>
        `资金受限错过的信号平均仍在上涨,错过的是真 alpha——考虑提高每轮分配数 MAX_ALLOCATIONS_PER_RUN(当前 ${cfg2.maxAllocationsPerRun})或当日买入预算(config.macroRegimeParams.dailyBuyBudget),让资金摊到更多高分信号上。`,
      okText: () => '资金受限错过的信号没有跑出超额收益,当前预算分配未造成明显机会成本。',
    },
    {
      id: 'conflict_hold_cost',
      title: '多空冲突搁置的信号',
      match: (r) => !r.traded && r.candidate_status === 'conflict_hold',
      minN: t.minSamplesBlocked,
      adjustText: (cfg2) =>
        `冲突搁置的信号平均仍在上涨,搁置窗口可能过长——考虑缩短 CONFLICT_WINDOW_MINUTES(当前 ${cfg2.conflictWindowMinutes} 分钟)或调低冲突判定的主导阈值。`,
      okText: () => '冲突搁置的信号平均在下跌,冲突消解正在避免损失。',
    },
  ];
  for (const rule of blockedRules) {
    const m = subsetMetrics(rows.filter(rule.match));
    if (m.n >= rule.minN && m.mean !== null && m.mean >= t.edgePercent) {
      suggestions.push({
        id: rule.id,
        level: 'adjust',
        title: rule.title,
        evidence: evidenceText(m),
        suggestion: rule.adjustText(cfg),
      });
    } else if (m.n >= rule.minN && m.mean !== null && m.mean <= -t.edgePercent) {
      suggestions.push({
        id: rule.id,
        level: 'ok',
        title: rule.title,
        evidence: evidenceText(m),
        suggestion: rule.okText(cfg),
      });
    } else {
      skip(rule.id, rule.title, m);
    }
  }

  // 7. 置信度校准:最高置信桶命中率显著低于最低置信桶 → 置信度刻度失真
  {
    const buckets = [
      { label: '<0.6', match: (r) => r.confidence !== null && r.confidence < 0.6 },
      { label: '0.6~0.7', match: (r) => r.confidence !== null && r.confidence >= 0.6 && r.confidence < 0.7 },
      { label: '0.7~0.8', match: (r) => r.confidence !== null && r.confidence >= 0.7 && r.confidence < 0.8 },
      { label: '0.8~0.9', match: (r) => r.confidence !== null && r.confidence >= 0.8 && r.confidence < 0.9 },
      { label: '≥0.9', match: (r) => r.confidence !== null && r.confidence >= 0.9 },
    ];
    const qualified = buckets
      .map((b) => ({ label: b.label, m: subsetMetrics(rows.filter(b.match)) }))
      .filter((b) => b.m.n >= t.minSamplesBlocked);
    const title = '分析置信度校准(置信度越高命中率应越高)';
    if (qualified.length >= 3) {
      const lowest = qualified[0];
      const highest = qualified[qualified.length - 1];
      if (highest.m.hitHi !== null && lowest.m.hitLo !== null && highest.m.hitHi < lowest.m.hitLo) {
        suggestions.push({
          id: 'confidence_calibration',
          level: 'adjust',
          title,
          evidence: `${lowest.label}:${evidenceText(lowest.m)};${highest.label}:${evidenceText(highest.m)}`,
          suggestion:
            '高置信桶的命中率显著低于低置信桶,置信度刻度已失真——单纯提高门槛无效,应校准 analyst prompt 的置信度定义,或复核 sizing.js 的置信度→仓位映射是否在放大失真。',
        });
      } else {
        skipped.push({ id: 'confidence_calibration', title, reason: '未出现显著的校准倒挂' });
      }
    } else {
      skipped.push({ id: 'confidence_calibration', title, reason: '样本足够的置信度分桶不足 3 个' });
    }
  }

  return { suggestions, skipped };
}

/**
 * 实盘兑现规则(纯函数,±2%/48h 策略口径):outcomeRows 为 loadSignalRows 的
 * outcomeRows(每行一笔已平仓卖单:{ trigger, realized_pnl, tier, source_score, is_press })。
 * 前瞻收益答"信号有没有 alpha",这组规则答"信号与固定敞口/持有时限的离场规则是否匹配"。
 */
export function evaluateOutcomeRules(outcomeRows, cfg, t = ADVISOR_THRESHOLDS) {
  const suggestions = [];
  const skipped = [];
  const rows = outcomeRows || [];
  const share = (subset, trigger) =>
    subset.length ? (subset.filter((r) => r.trigger === trigger).length / subset.length) * 100 : null;

  // 1. 全部平仓的止损/止盈占比:止损显著占优 → 信号与 ±2% 敞口不匹配
  {
    const title = '实盘兑现:离场触发分布(全部平仓)';
    const n = rows.length;
    const slShare = share(rows, 'stop_loss');
    const tpShare = share(rows, 'take_profit');
    const evidence = () =>
      `平仓 ${n} 笔:止盈 ${round(tpShare, 1)}%,止损 ${round(slShare, 1)}%,持有超时 ${round(share(rows, 'max_hold'), 1)}%`;
    if (n >= t.minSamplesOutcome && slShare !== null && slShare >= t.stopShareHighPercent) {
      suggestions.push({
        id: 'outcome_stop_share',
        level: 'adjust',
        title,
        evidence: evidence(),
        suggestion: cfg.volBracketEnabled
          ? `止损离场占比过半,信号与波动自适应敞口(clamp(${cfg.bracketVolK}×20日波动, ${cfg.bracketMinPercent}%, ${cfg.bracketMaxPercent}%))不匹配——先提高综合置信度门槛 MIN_FINAL_CONFIDENCE(当前 ${cfg.minFinalConfidence})收紧入场;若「按事件档位」的 1h/1d 命中率仍然过硬,再考虑上调 BRACKET_MAX_PERCENT 或 BRACKET_VOL_K(敞口仍过窄,噪音扫损)。`
          : `止损离场占比过半,信号与固定 ±${cfg.stopLossPercent}% 敞口不匹配——先提高综合置信度门槛 MIN_FINAL_CONFIDENCE(当前 ${cfg.minFinalConfidence})收紧入场;若「按事件档位」的 1h/1d 命中率仍然过硬,再考虑复核 STOP_LOSS_PERCENT/TAKE_PROFIT_PERCENT 的敞口是否过窄(噪音扫损)。`,
      });
    } else if (n >= t.minSamplesOutcome && tpShare !== null && tpShare >= t.stopShareHighPercent) {
      suggestions.push({
        id: 'outcome_stop_share',
        level: 'ok',
        title,
        evidence: evidence(),
        suggestion: '止盈离场占比过半,信号强度与当前固定敞口/持有时限匹配良好,维持现状。',
      });
    } else {
      skipped.push({
        id: 'outcome_stop_share',
        title,
        reason: n < t.minSamplesOutcome ? `样本不足(${n} < ${t.minSamplesOutcome})` : '止盈/止损占比均未过半,无显著结论',
      });
    }
  }

  // 2. 低可信来源的兑现质量:止损显著占优 → 加大来源折价/门槛
  {
    const subset = rows.filter((r) => r.source_score !== null && Number(r.source_score) < 0.65);
    const title = '实盘兑现:低可信来源(<0.65)信号的平仓质量';
    const n = subset.length;
    const slShare = share(subset, 'stop_loss');
    if (n >= t.minSamplesOutcome && slShare !== null && slShare >= t.stopShareHighPercent) {
      suggestions.push({
        id: 'outcome_low_source',
        level: 'adjust',
        title,
        evidence: `平仓 ${n} 笔:止损占 ${round(slShare, 1)}%`,
        suggestion: `低可信来源信号的持仓过半被止损打出,建议提高 MIN_FINAL_CONFIDENCE(当前 ${cfg.minFinalConfidence})或加深来源折价,让这类信号更多挂起等交叉确认。`,
      });
    } else {
      skipped.push({
        id: 'outcome_low_source',
        title,
        reason: n < t.minSamplesOutcome ? `样本不足(${n} < ${t.minSamplesOutcome})` : '止损占比未过半,无显著结论',
      });
    }
  }

  return { suggestions, skipped };
}

/**
 * 影子组合对照规则(纯函数):每个消融变体与实盘同窗收益差超过阈值才发声。
 * variants 为 getShadowOverview 的变体行,须带 window_return_pct(同窗收益,由窗口内
 * 净值序列首末两点算出)——变体的 pnl_percent 是自建立以来的累计收益,运行天数超过
 * 统计窗后与实盘窗口收益口径错配,会产出方向错误的建议,这里不使用。
 * actualReturnPct 为实盘同窗收益(百分点)。
 */
export function evaluateShadowRules({ variants, actualReturnPct, now = Date.now() }, t = ADVISOR_THRESHOLDS) {
  const suggestions = [];
  const skipped = [];
  if (!Array.isArray(variants) || actualReturnPct === null || actualReturnPct === undefined) {
    return { suggestions, skipped: [{ id: 'shadow', title: '影子组合对照', reason: '影子组合数据不可用' }] };
  }
  // 每变体的标题与建议文案:入场侧两个消融沿用原文案;出场侧三个(023)针对
  // ±2%/48h 出场规则给出方向性建议——vol_bracket 的建议直接指向管理页运行时开关(自熄闭环)
  const ablation = {
    no_risk_officer: {
      title: '消融对照:关闭风控官(no_risk_officer)',
      adjust: '关闭风控官的影子组合显著跑赢实盘,风控官可能在损耗收益——结合上方对应拦截层的机会成本统计交叉验证后再考虑放宽。',
      ok: '关闭风控官的影子组合显著跑输实盘,风控官正在创造净收益,维持现状。',
    },
    no_macro_filter: {
      title: '消融对照:关闭宏观过滤(no_macro_filter)',
      adjust: '关闭宏观过滤的影子组合显著跑赢实盘,宏观过滤可能在损耗收益——结合上方对应拦截层的机会成本统计交叉验证后再考虑放宽。',
      ok: '关闭宏观过滤的影子组合显著跑输实盘,宏观过滤正在创造净收益,维持现状。',
    },
    wide_bracket: {
      title: '消融对照:宽敞口离场(wide_bracket,±4%/96h)',
      adjust:
        '宽敞口镜像显著跑赢实盘,固定 ±2%/48h 出场可能过窄(噪音扫损截断信号表达)——结合「实盘兑现」的止损占比交叉验证后,考虑上调 STOP_LOSS_PERCENT/TAKE_PROFIT_PERCENT/MAX_HOLD_HOURS,或在管理员页开启波动自适应敞口并上调 BRACKET_MAX_PERCENT。',
      ok: '宽敞口镜像显著跑输实盘,±2%/48h 的快进快出正在创造净收益,维持现状。',
    },
    trailing_only: {
      title: '消融对照:仅移动止损(trailing_only,无止盈上限)',
      adjust:
        '仅移动止损(无止盈上限)的镜像显著跑赢实盘,固定止盈可能在截断利润——考虑开启 ENABLE_TRAILING_STOP,并评估放宽或取消固定止盈上限(让利润奔跑,由移动止损锁盈)。',
      ok: '仅移动止损镜像显著跑输实盘,固定止盈的落袋纪律正在创造净收益,维持现状。',
    },
    vol_bracket: {
      title: '消融对照:波动自适应敞口(vol_bracket)',
      adjust:
        '波动自适应敞口镜像显著跑赢实盘——建议在管理员页开启「波动自适应敞口」运行时开关(无需改环境变量);开启后实盘与本变体趋同,该建议将自然消失。',
      ok: '波动自适应敞口镜像显著跑输实盘,固定 ±2% 敞口更优,维持关闭。',
    },
  };
  for (const [variant, copy] of Object.entries(ablation)) {
    const v = variants.find((x) => x.variant === variant);
    const title = copy.title;
    if (!v) {
      skipped.push({ id: `shadow_${variant}`, title, reason: '变体不存在' });
      continue;
    }
    const runtimeDays = (now - new Date(v.started_at).getTime()) / 86400_000;
    if (!Number.isFinite(runtimeDays) || runtimeDays < t.shadowMinDays) {
      skipped.push({
        id: `shadow_${variant}`,
        title,
        reason: `运行 ${Math.max(Math.floor(runtimeDays || 0), 0)} 天 < ${t.shadowMinDays} 天,样本期不足`,
      });
      continue;
    }
    const variantPct = Number(v.window_return_pct);
    if (!Number.isFinite(variantPct)) {
      skipped.push({ id: `shadow_${variant}`, title, reason: '窗口内净值序列不足,无法计算同窗收益' });
      continue;
    }
    const diff = round(variantPct - Number(actualReturnPct));
    const evidence = `运行 ${Math.floor(runtimeDays)} 天:该变体同窗收益 ${variantPct >= 0 ? '+' : ''}${round(variantPct)}%,实盘同窗 ${actualReturnPct >= 0 ? '+' : ''}${round(Number(actualReturnPct))}%,差 ${diff >= 0 ? '+' : ''}${diff} 个百分点`;
    if (diff >= t.shadowEdgePercent) {
      suggestions.push({
        id: `shadow_${variant}`,
        level: 'adjust',
        title,
        evidence,
        suggestion: copy.adjust,
      });
    } else if (diff <= -t.shadowEdgePercent) {
      suggestions.push({
        id: `shadow_${variant}`,
        level: 'ok',
        title,
        evidence,
        suggestion: copy.ok,
      });
    } else {
      skipped.push({ id: `shadow_${variant}`, title, reason: `与实盘差异 ${diff >= 0 ? '+' : ''}${diff}% 未超过 ±${t.shadowEdgePercent}% 阈值` });
    }
  }
  return { suggestions, skipped };
}

/** 实盘同窗收益(百分点):窗口内首末两条净值快照;不可用返回 null */
async function actualWindowReturn(sinceIso) {
  try {
    const base = () =>
      supabase()
        .from('portfolio_snapshots')
        .select('total_value, created_at')
        .gte('created_at', sinceIso);
    const [firstRes, lastRes] = await Promise.all([
      base().order('created_at', { ascending: true }).limit(1),
      base().order('created_at', { ascending: false }).limit(1),
    ]);
    const first = Number(firstRes.data?.[0]?.total_value);
    const last = Number(lastRes.data?.[0]?.total_value);
    if (!(first > 0) || !Number.isFinite(last)) return null;
    return ((last - first) / first) * 100;
  } catch {
    return null;
  }
}

/**
 * /api/admin/advisor 的数据来源:近 days 天的信号统计规则 + 影子组合对照规则。
 * 011 未迁移(无前瞻收益)时返回 { available: false }。
 */
export async function getParameterAdvice({ days = 30 } = {}) {
  const loaded = await loadSignalRows({ days });
  if (!loaded) return { available: false };

  const signal = evaluateSignalRules(loaded.rows, config);
  // volBracketEnabled 是运行时开关(023,非 env),纯函数经 cfg 感知模式切换建议文案
  const outcome = evaluateOutcomeRules(loaded.outcomeRows, {
    ...config,
    volBracketEnabled: isVolBracketEnabled(),
  });

  // 影子组合对照(017 未迁移/未启用时静默跳过该组规则)
  let shadow = { suggestions: [], skipped: [{ id: 'shadow', title: '影子组合对照', reason: '影子组合数据不可用' }] };
  try {
    const overview = config.enableShadow ? await getShadowOverview({ hours: days * 24 }) : null;
    if (overview?.variants?.length) {
      const earliestStart = overview.variants
        .map((v) => v.started_at)
        .filter(Boolean)
        .sort()[0];
      const since = new Date(
        Math.max(Date.now() - days * 86400_000, earliestStart ? new Date(earliestStart).getTime() : 0)
      ).toISOString();
      const actualPct = await actualWindowReturn(since);
      // 同窗口径:各变体的窗口收益由窗口内净值序列首末两点算出,与实盘窗口对齐
      const variants = overview.variants.map((v) => {
        const points = overview.series?.[v.variant] || [];
        const first = Number(points[0]?.total_value);
        const last = Number(points[points.length - 1]?.total_value);
        const windowReturnPct =
          points.length >= 2 && first > 0 && Number.isFinite(last)
            ? ((last - first) / first) * 100
            : null;
        return { ...v, window_return_pct: windowReturnPct };
      });
      shadow = evaluateShadowRules({ variants, actualReturnPct: actualPct });
    }
  } catch (err) {
    console.warn(`[advisor] 影子组合对照不可用: ${err.message}`);
  }

  return {
    available: true,
    generated_at: new Date().toISOString(),
    window: loaded.window,
    sample: loaded.rows.length,
    thresholds: ADVISOR_THRESHOLDS,
    suggestions: [...signal.suggestions, ...outcome.suggestions, ...shadow.suggestions],
    skipped: [...signal.skipped, ...outcome.skipped, ...shadow.skipped],
  };
}
