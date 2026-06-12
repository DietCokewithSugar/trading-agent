// 资金分配器:候选池统一打分排序 → 冲突消解 → 按分数高低把资金分给最优信号。
// 解决"先到的新闻把现金买光"的路径依赖:谁分高谁先买,资金不足的标记
// capital_constrained 留池,下一轮(或卖出释放现金后)自动复评。
// 节奏(用户指定):非盘中只入池持续排序;开盘首轮立即清算隔夜候选,
// 盘中每 ALLOCATION_INTERVAL_MINUTES 一轮。LLM 交易决策只对每轮头部候选发生。
// 本文件上半部为纯函数(打分/合并/排名,node:test 直接测),下半部为编排薄层。
import { supabase } from '../db.js';
import { config } from '../config.js';
import { getMarketSession } from './fmp.js';
import { isHalted } from './halt.js';
import { etDayKey } from './metrics.js';
import { broadcast } from './bus.js';
import { getEffectiveRegime, sectorMultiplier } from './macroRegime.js';
import { listRecentMacroEvents } from './macroService.js';
import { getBlackoutState } from './macroCalendar.js';
import { resolveConflicts, tierScore } from './conflictResolver.js';
import {
  isPoolAvailable,
  listActiveCandidates,
  updateCandidate,
  getCandidateStatus,
  expireStale,
  cancelLowScore,
  cancelSiblings,
  countByStatus,
} from './candidateStore.js';
import { executeCandidate } from './trader.js';
import { getPortfolio } from './portfolio.js';

export { tierScore };

/** 信号时效衰减:与 credibility.recencyScore 同口径(1 小时内 1.0,线性衰减到 24 小时 0.5) */
export function decayFactor(ageHours) {
  if (!Number.isFinite(ageHours) || ageHours < 0) return 0.7;
  if (ageHours <= 1) return 1;
  return Math.max(0.5, 1 - (0.5 * (ageHours - 1)) / 23);
}

/**
 * 候选打分:档位 × LLM 置信度 × 时效衰减 × 来源可信度 × 宏观乘数 × 行业乘数。
 * 缺失置信度/来源分按 0.7 计(与 sizing 链缺省一致)。返回保留三位小数。
 */
export function scoreCandidate(candidate, { now = new Date(), macroMultiplier = 1, sectorMult = 1 } = {}) {
  const nowTs = now instanceof Date ? now.getTime() : Number(now);
  const ageHours = (nowTs - new Date(candidate.created_at || nowTs).getTime()) / 3600_000;
  const conf = Number.isFinite(Number(candidate.confidence)) ? Number(candidate.confidence) : 0.7;
  const src = Number.isFinite(Number(candidate.source_score)) ? Number(candidate.source_score) : 0.7;
  const score =
    tierScore(candidate.tier) * conf * decayFactor(ageHours) * src * macroMultiplier * sectorMult;
  return Number(Math.max(score, 0).toFixed(3));
}

/**
 * 同票候选合并:取最高分者为代表,多事件共振给小幅加成(+0.05/条,上限 +0.1)。
 * 返回 { merged: 代表候选(带 score), absorbed: [{ candidate, into }] }。
 * 输入候选需已带 score 字段。
 */
export function mergeBySymbol(candidates) {
  const groups = new Map();
  for (const c of candidates || []) {
    if (!groups.has(c.symbol)) groups.set(c.symbol, []);
    groups.get(c.symbol).push(c);
  }
  const merged = [];
  const absorbed = [];
  for (const group of groups.values()) {
    group.sort((a, b) => (b.score || 0) - (a.score || 0));
    const rep = group[0];
    const bonus = Math.min(0.05 * (group.length - 1), 0.1);
    merged.push({ ...rep, score: Number(((rep.score || 0) + bonus).toFixed(3)) });
    for (const other of group.slice(1)) absorbed.push({ candidate: other, into: rep });
  }
  return { merged, absorbed };
}

/**
 * 刷分是否需要落库(纯函数):状态变化永远写;纯分数刷新只在变化 ≥ threshold 时写,
 * 避免每轮对全池(最多 200 行)做无意义的串行往返。prevScore 非法(NaN/首次)视为需要写。
 */
export function shouldWriteScore({ prevScore, nextScore, statusChanged, threshold = 0.01 } = {}) {
  if (statusChanged) return true;
  const prev = Number(prevScore);
  if (!Number.isFinite(prev)) return true;
  return Math.abs(Number(nextScore) - prev) >= threshold;
}

/** 排名:分数降序;同分按综合置信度降序、入池时间升序(先到先得只在同分时生效) */
export function rankCandidates(candidates) {
  return [...(candidates || [])].sort((a, b) => {
    const scoreDiff = (b.score || 0) - (a.score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    const confDiff = (Number(b.final_confidence) || 0) - (Number(a.final_confidence) || 0);
    if (confDiff !== 0) return confDiff;
    return new Date(a.created_at || 0) - new Date(b.created_at || 0);
  });
}

/**
 * 本轮执行计划:取排名前 maxPerRun 个(LLM 交易决策只对这些头部候选发生,
 * 其余留池下轮复评);minScore 过滤掉衰减后已无意义的尾部分数。
 */
export function planAllocations({ ranked, maxPerRun = 3, minScore = 0.05 } = {}) {
  return (ranked || []).filter((c) => (c.score || 0) >= minScore).slice(0, Math.max(maxPerRun, 0));
}

// ── 编排薄层 ──

/** 分配器运行状态(adminService 重置前 drain 用) */
export const allocatorStatus = {
  running: false,
  lastRunAt: null, // 毫秒时间戳
  lastRunDay: null, // 美东日(开盘首跑判定)
  lastResult: null,
};

/** 资金/配额类拒绝:候选标记 capital_constrained 留池,卖出释放现金或次日配额恢复后复评 */
const CAPITAL_REASONS = new Set(['cash_reserve', 'daily_budget', 'gross_exposure', 'new_position_quota']);
/** 全局临时状态:本轮直接停止执行,候选保持原状态等下一轮 */
const GLOBAL_TRANSIENT_REASONS = new Set(['trading_halted', 'daily_loss_halt', 'macro_shock']);

/**
 * 调度器每分钟调用:盘中按 ALLOCATION_INTERVAL_MINUTES 限速,
 * 开盘后的第一个 tick 立即执行(清算隔夜积累的候选)。非盘中不执行。
 */
export async function maybeRunAllocation() {
  if (!config.enableMacro || !isPoolAvailable()) return;
  if (getMarketSession() !== 'regular') return;
  const today = etDayKey();
  const firstRunOfDay = allocatorStatus.lastRunDay !== today;
  const intervalMs = Math.max(config.allocationIntervalMinutes, 1) * 60_000;
  if (!firstRunOfDay && Date.now() - (allocatorStatus.lastRunAt || 0) < intervalMs) return;
  await runAllocation({ trigger: firstRunOfDay ? 'open' : 'interval' });
}

/** 执行一轮资金分配。任何失败只告警,绝不向调度器抛出 */
export async function runAllocation({ trigger = 'manual' } = {}) {
  if (allocatorStatus.running || isHalted()) return;
  if (!config.enableMacro || !isPoolAvailable()) return;
  allocatorStatus.running = true;
  const startedAt = Date.now();
  try {
    await expireStale();
    const candidates = await listActiveCandidates();
    // 节奏标记在加载后就绪时更新:本轮无论结果如何都算跑过
    allocatorStatus.lastRunAt = startedAt;
    allocatorStatus.lastRunDay = etDayKey();
    if (!candidates || !candidates.length) return;

    // 生效参数 = 新闻 regime ∩ 确定性市场核验(016):核验不同向时 risk_on 放大被钳制
    const regime = getEffectiveRegime();
    const params = regime.params;

    // 宏观冲击:不执行任何买入,低分候选直接取消,高分候选留池待冲击解除
    if (regime.regime === 'macro_shock') {
      await cancelLowScore(0.3, '宏观冲击期间取消低分候选');
      console.log(`[allocator] 宏观冲击状态,本轮不执行买入(${candidates.length} 个候选留池)`);
      return;
    }

    // 重大数据发布黑窗:候选原样留池,本轮整体不买(卖出/止损不经此路径)
    const blackout = getBlackoutState();
    if (blackout.inBlackout) {
      console.log(
        `[allocator] 数据发布黑窗(${blackout.event?.event || '未知事件'},至 ${blackout.until}),本轮不执行买入`
      );
      return;
    }

    // 上下文:近期宏观事件(行业乘数)、持仓、待开盘卖单、冲突窗口内的利空信号
    const now = new Date();
    const symbols = [...new Set(candidates.map((c) => c.symbol))];
    const [macroEvents, { positions }, sellOrders, opposing] = await Promise.all([
      listRecentMacroEvents(config.macroEventValidityHours).catch(() => []),
      getPortfolio(),
      loadPendingSellOrders(symbols),
      loadOpposingSignals(symbols, now),
    ]);
    const events = macroEvents || [];

    // 刷新分数(时效衰减 × 宏观乘数 × 行业乘数)并按 regime 过滤档位/置信度。
    // 写入先收集再批量提交:状态不变且分数变化 < 阈值的不写,其余 20 个一批并发,
    // 全部带乐观并发(状态被其它路径并发改掉的候选本轮不再参与)
    const allowedTiers = new Set(params.allowedTiers || []);
    const preScored = [];
    const scoreWrites = [];
    for (const candidate of candidates) {
      const sectorMult = sectorMultiplier(candidate.sector, events, now, {
        validityHours: config.macroEventValidityHours,
      });
      const score = scoreCandidate(candidate, {
        now,
        macroMultiplier: params.macroMultiplier,
        sectorMult,
      });
      if (
        !allowedTiers.has(candidate.tier) ||
        (params.minConfidence && Number(candidate.confidence || 0) < params.minConfidence)
      ) {
        // 非终态:regime 变化后自动回到排名
        scoreWrites.push({
          candidate,
          statusChanged: candidate.status !== 'macro_filtered',
          fields: {
            current_score: score,
            status: 'macro_filtered',
            status_reason: `当前宏观环境(${regime.regime})只允许档位 ${[...allowedTiers].join('/') || '无'}${params.minConfidence ? ` 且置信度≥${params.minConfidence}` : ''}`,
          },
        });
        continue;
      }
      scoreWrites.push({ candidate, statusChanged: false, fields: { current_score: score } });
      // 曾被宏观过滤/冲突搁置的候选回到待分配(冲突由下方 resolveConflicts 重新判定)
      preScored.push({ ...candidate, score, sectorMult });
    }
    const missedIds = await flushCandidateWrites(scoreWrites);
    const scored = preScored.filter((c) => !missedIds.has(c.id));
    if (!scored.length) return;

    // 冲突消解(每轮全量重判:冲突窗口滑动,出窗后自动解除搁置)
    const conflicts = resolveConflicts({
      buyCandidates: scored,
      pendingSellOrders: sellOrders,
      recentOpposingSignals: opposing,
      positions,
      regime: regime.regime,
      cfg: { dominanceRatio: 1.5, conflictScale: 0.5 },
    });
    for (const { candidate, reason } of conflicts.held) {
      if (candidate.status !== 'conflict_hold') {
        await updateCandidate(
          candidate.id,
          { status: 'conflict_hold', status_reason: reason },
          { expectedStatus: candidate.status }
        );
      }
    }
    for (const { candidate, reason } of conflicts.cancelled) {
      await updateCandidate(
        candidate.id,
        { status: 'cancelled', status_reason: reason },
        { expectedStatus: candidate.status }
      );
    }
    const scaleById = new Map();
    const reEligible = [...conflicts.allowed];
    for (const { candidate, scale, reason } of conflicts.reducedSize) {
      scaleById.set(candidate.id, { scale, note: reason });
      reEligible.push(candidate);
    }
    // 曾被搁置/过滤但本轮重新可跑的候选恢复 pending;乐观并发未命中
    //(状态刚被其它路径改写,如新到利空触发的 conflict_hold)的候选本轮不再执行
    const runnable = [];
    for (const candidate of reEligible) {
      if (candidate.status !== 'pending') {
        const ok = await updateCandidate(
          candidate.id,
          { status: 'pending', status_reason: '复评后恢复待分配' },
          { expectedStatus: candidate.status }
        );
        if (!ok) continue;
        candidate.status = 'pending';
      }
      runnable.push(candidate);
    }

    // 同票合并 → 排名 → 取前 N 执行
    const { merged } = mergeBySymbol(runnable);
    const planned = planAllocations({
      ranked: rankCandidates(merged),
      maxPerRun: config.maxAllocationsPerRun,
    });
    if (!planned.length) return;
    console.log(
      `[allocator] 本轮(${trigger})候选 ${candidates.length} → 可执行 ${merged.length},执行前 ${planned.length} 个: ${planned.map((c) => `${c.symbol}(${c.score})`).join(' ')}${regime.clamped ? '(确定性核验钳制 risk_on 放大)' : ''}`
    );

    let allocated = 0;
    let halted = false;
    for (let i = 0; i < planned.length; i += 1) {
      const candidate = planned[i];
      const conflictScale = scaleById.get(candidate.id);
      const macroContext = {
        regime: regime.regime,
        riskScore: Number(regime.risk_score),
        recentEvents: events.slice(0, 3),
        sectorImpact:
          candidate.sectorMult > 1 ? 'bullish' : candidate.sectorMult < 1 ? 'bearish' : null,
        conflictNote: conflictScale ? '同票近期存在反向信号(已缩仓)' : null,
      };
      // 执行前重读状态:加载快照到此刻之间(尤其是排在前面的候选的 LLM 长调用期间)
      // 候选可能已被并发改为 conflict_hold/cancelled,内存快照不可信
      const freshStatus = await getCandidateStatus(candidate.id);
      if (freshStatus !== 'pending') {
        console.log(
          `[allocator] ${candidate.symbol} 候选 #${candidate.id} 状态已变为 ${freshStatus || '未知'},本轮跳过执行`
        );
        continue;
      }
      let result;
      try {
        result = await executeCandidate(candidate, {
          macroContext,
          extraScale: conflictScale ? conflictScale.scale : 1,
        });
      } catch (err) {
        console.warn(`[allocator] ${candidate.symbol} 执行失败(候选留池): ${err.message}`);
        continue;
      }

      if (result?.trade) {
        allocated += 1;
        await updateCandidate(candidate.id, {
          status: 'allocated',
          trade_id: result.trade.id,
          status_reason: null,
          macro_regime: regime.regime,
        });
        await cancelSiblings(candidate.symbol, candidate.id, '同票候选已成交,合并取消');
        broadcast('trade', result.trade);
        continue;
      }
      const reason = result?.reason || 'unknown';
      if (CAPITAL_REASONS.has(reason)) {
        // 资金/配额耗尽:本候选与排名靠后的全部标记 capital_constrained,留池复评
        for (const rest of planned.slice(i)) {
          await updateCandidate(
            rest.id,
            { status: 'capital_constrained', status_reason: result.reject },
            { expectedStatus: 'pending' }
          );
        }
        console.log(`[allocator] 资金/配额受限(${reason}),其余候选留池等待资金释放`);
        break;
      }
      if (GLOBAL_TRANSIENT_REASONS.has(reason)) {
        console.log(`[allocator] 全局暂停(${reason}),本轮停止执行`);
        halted = true;
        break;
      }
      if (result?.transient) {
        // 个体临时失败(报价缺失/价格漂移):保持现状,下一轮重试
        console.log(`[allocator] ${candidate.symbol} 暂缓(${reason}),候选留池`);
        continue;
      }
      await updateCandidate(
        candidate.id,
        { status: 'rejected', status_reason: result?.reject || reason },
        { expectedStatus: 'pending' }
      );
    }

    allocatorStatus.lastResult = {
      trigger,
      at: new Date(startedAt).toISOString(),
      candidates: candidates.length,
      planned: planned.length,
      allocated,
      halted,
      durationMs: Date.now() - startedAt,
    };
    console.log(
      `[allocator] 本轮完成: 成交 ${allocated}/${planned.length},用时 ${Date.now() - startedAt}ms`
    );
    broadcast('macro', { pool: await countByStatus() });
  } catch (err) {
    console.error(`[allocator] 本轮分配失败: ${err.message}`);
  } finally {
    allocatorStatus.running = false;
  }
}

/**
 * 批量提交刷分写入:shouldWriteScore 过滤掉无意义的纯分数写,其余 20 个一批并发,
 * 全部带乐观并发(expectedStatus=加载时状态)。返回未命中的候选 id 集合
 * (状态已被并发修改,调用方将其从本轮可执行集合中剔除)。
 */
async function flushCandidateWrites(writes) {
  const missed = new Set();
  const pending = (writes || []).filter((w) =>
    shouldWriteScore({
      prevScore: w.candidate.current_score,
      nextScore: w.fields.current_score,
      statusChanged: w.statusChanged,
    })
  );
  for (let i = 0; i < pending.length; i += 20) {
    await Promise.all(
      pending.slice(i, i + 20).map(async (w) => {
        const ok = await updateCandidate(w.candidate.id, w.fields, {
          expectedStatus: w.candidate.status,
        });
        if (!ok) missed.add(w.candidate.id);
      })
    );
  }
  return missed;
}

/** 候选同票的待开盘卖单(冲突消解输入);查询失败按空处理 */
async function loadPendingSellOrders(symbols) {
  if (!symbols.length) return [];
  try {
    const { data, error } = await supabase()
      .from('pending_orders')
      .select('symbol, side, status')
      .eq('side', 'sell')
      .eq('status', 'pending')
      .in('symbol', symbols);
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

/** 冲突窗口内候选同票的利空信号(冲突消解输入);查询失败按空处理 */
async function loadOpposingSignals(symbols, now) {
  if (!symbols.length) return [];
  try {
    const since = new Date(now.getTime() - config.conflictWindowMinutes * 60_000).toISOString();
    const { data, error } = await supabase()
      .from('news_analyses')
      .select('symbol, sentiment, tier, confidence, final_confidence, created_at')
      .eq('sentiment', 'bearish')
      .in('symbol', symbols)
      .gte('created_at', since)
      .limit(100);
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}
