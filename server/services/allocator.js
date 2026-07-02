// 资金分配器:候选池统一打分排序 → 冲突消解 → 按分数高低把资金分给最优信号。
// 解决"先到的新闻把现金买光"的路径依赖:谁分高谁先买,资金不足的标记
// capital_constrained 留池,下一轮(或卖出释放现金后)自动复评。
// 节奏(用户指定):休市(夜间/周末/假日)只入池持续排序;可交易时段(盘前 04:00 起,
// 含盘中/盘后至 20:00)每 ALLOCATION_INTERVAL_MINUTES 一轮,当日首轮(盘前开始)
// 立即清算隔夜候选。LLM 交易决策只对每轮头部候选发生。
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
  cancelSiblings,
  countByStatus,
} from './candidateStore.js';
import { executeCandidate, executeSellOrder } from './trader.js';
import { getPortfolio, getValuation } from './portfolio.js';
import { onMacroFilteredCandidates } from './shadowPortfolio.js';
import { pickRotationSell } from './rotation.js';

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
  // 资金受限闸门:上次预算类拒绝时的现金水位与美东日。现金未高于该水位且未跨日时,
  // capital_constrained 候选不复位重跑(省去注定再被预算拒绝的整条 LLM 决策链)
  capitalGate: null,
};

/** 资金/配额类拒绝:候选标记 capital_constrained 留池,卖出释放现金或次日配额恢复后复评 */
const CAPITAL_REASONS = new Set(['cash_reserve', 'daily_budget', 'gross_exposure', 'new_position_quota']);
/** 单候选级的容量类拒绝:只约束该候选自身(加仓豁免持仓数上限/单票帽只限同票),不级联其它候选 */
const PER_CANDIDATE_CAPITAL_REASONS = new Set(['max_positions', 'position_cap']);
/** 全局临时状态:本轮直接停止执行,候选保持原状态等下一轮 */
const GLOBAL_TRANSIENT_REASONS = new Set(['trading_halted', 'daily_loss_halt', 'macro_shock']);

/**
 * 止盈腾位(选盈利票机制)可触发的拒绝原因:卖出确实能缓解的容量/现金类约束。
 * 排除 daily_budget(卖出不回补当日买入预算)、new_position_quota(卖出不恢复开仓配额)、
 * position_cap(同票仓位帽,卖别的票无济于事)。
 */
const ROTATION_REASONS = new Set(['max_positions', 'cash_reserve', 'gross_exposure']);

/**
 * 调度器每分钟调用:可交易时段(盘前 04:00 起,含盘中/盘后)按
 * ALLOCATION_INTERVAL_MINUTES 限速,当日第一个 tick(盘前开始时)立即执行,
 * 清算隔夜积累的候选。休市(夜间/周末/假日)不执行,候选只入池排序。
 */
export async function maybeRunAllocation() {
  if (!config.enableMacro || !isPoolAvailable()) return;
  if (getMarketSession() === 'closed') return;
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
    // 读库失败(null)不消耗节奏标记:开盘首跑碰上瞬时 DB 错误时,下一 tick 立即重试
    // 而不是把隔夜候选清算推迟一个完整 interval
    if (!Array.isArray(candidates)) return;
    // 节奏标记在加载成功后更新:本轮无论结果如何都算跑过
    allocatorStatus.lastRunAt = startedAt;
    allocatorStatus.lastRunDay = etDayKey();
    if (!candidates.length) return;

    // 生效参数 = 新闻 regime ∩ 确定性市场核验(016):核验不同向时 risk_on 放大被钳制
    const regime = getEffectiveRegime();
    const params = regime.params;

    // 宏观冲击:不执行任何买入,低分候选直接取消,高分候选留池待冲击解除。
    // 取消判定用即时重算的分数(时效衰减),不依赖上一正常轮留下的 stale current_score
    if (regime.regime === 'macro_shock') {
      const shockNow = new Date();
      for (const candidate of candidates) {
        const fresh = scoreCandidate(candidate, { now: shockNow });
        if (fresh < 0.3) {
          await updateCandidate(
            candidate.id,
            { status: 'cancelled', current_score: fresh, status_reason: '宏观冲击期间取消低分候选' },
            { expectedStatus: candidate.status, expectedUpdatedAt: candidate.updated_at }
          );
        }
      }
      console.log(`[allocator] 宏观冲击状态,本轮不执行买入(${candidates.length} 个候选留池)`);
      // 影子组合:no_macro_filter 变体没有冲击门,头部候选照样重放(已买分析自动去重)
      onMacroFilteredCandidates(candidates, '宏观冲击暂停买入');
      return;
    }

    // 重大数据发布黑窗:候选原样留池,本轮整体不买(卖出/止损不经此路径)
    const blackout = getBlackoutState();
    if (blackout.inBlackout) {
      console.log(
        `[allocator] 数据发布黑窗(${blackout.event?.event || '未知事件'},至 ${blackout.until}),本轮不执行买入`
      );
      onMacroFilteredCandidates(candidates, '数据发布黑窗暂停买入');
      return;
    }

    // 上下文:近期宏观事件(行业乘数)、持仓、待开盘卖单、冲突窗口内的利空信号
    const now = new Date();
    const symbols = [...new Set(candidates.map((c) => c.symbol))];
    const [macroEvents, { state: portfolioState, positions }, sellOrders, opposing] = await Promise.all([
      listRecentMacroEvents(config.macroEventValidityHours).catch(() => []),
      getPortfolio(),
      loadPendingSellOrders(symbols),
      loadOpposingSignals(symbols, now),
    ]);
    const events = macroEvents || [];
    const cash = Number(portfolioState?.cash);
    // 本轮现金的滚动估计:每笔成交即时扣减。预算类拒绝时闸门必须记"拒绝时刻"的水位,
    // 记轮初快照会虚高(本轮成交越多越虚),导致卖出释放现金后 cash > gate.cash 永不成立,
    // capital_constrained 候选被错误冻结到跨日(并发卖出只会让真实现金高于此估计,
    // 闸门偏保守方向是放行,fail-open)
    let cashNow = cash;
    // 资金受限闸门:现金高于上次受限水位($1 容差)或已跨美东日(预算/配额重置)才放行复评;
    // 现金读取异常按放行处理(fail-open,宁可多花一次 LLM 也不长期冻结候选)
    const gate = allocatorStatus.capitalGate;
    const capitalFreed =
      !gate || gate.day !== etDayKey() || !Number.isFinite(cash) || cash > gate.cash + 1;
    if (capitalFreed) allocatorStatus.capitalGate = null;

    // 刷新分数(时效衰减 × 宏观乘数 × 行业乘数)并按 regime 过滤档位/置信度。
    // 写入先收集再批量提交:状态不变且分数变化 < 阈值的不写,其余 20 个一批并发,
    // 全部带乐观并发(状态被其它路径并发改掉的候选本轮不再参与)
    const allowedTiers = new Set(params.allowedTiers || []);
    const preScored = [];
    const scoreWrites = [];
    const regimeFiltered = [];
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
        regimeFiltered.push({ ...candidate, current_score: score });
        continue;
      }
      scoreWrites.push({ candidate, statusChanged: false, fields: { current_score: score } });
      // 曾被宏观过滤/冲突搁置的候选回到待分配(冲突由下方 resolveConflicts 重新判定)
      preScored.push({ ...candidate, score, sectorMult });
    }
    const { missed: missedIds, stamped } = await flushCandidateWrites(scoreWrites);
    // 影子组合:被 regime 档位/置信度过滤的候选在 no_macro_filter 变体里照样重放
    if (regimeFiltered.length) {
      onMacroFilteredCandidates(regimeFiltered, `宏观过滤(${regime.regime})`);
    }
    // 刷分写入会更新行的 updated_at(乐观并发版本号),同步回本轮内存快照,
    // 否则后续带 expectedUpdatedAt 的写入会拿旧版本号全部落空
    for (const c of preScored) {
      const ts = stamped.get(c.id);
      if (ts) c.updated_at = ts;
    }
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
          { expectedStatus: candidate.status, expectedUpdatedAt: candidate.updated_at }
        );
      }
    }
    for (const { candidate, reason } of conflicts.cancelled) {
      await updateCandidate(
        candidate.id,
        { status: 'cancelled', status_reason: reason },
        { expectedStatus: candidate.status, expectedUpdatedAt: candidate.updated_at }
      );
    }
    const scaleById = new Map();
    const reEligible = [...conflicts.allowed];
    for (const { candidate, scale, reason } of conflicts.reducedSize) {
      scaleById.set(candidate.id, { scale, note: reason });
      reEligible.push(candidate);
    }
    // 曾被搁置/过滤但本轮重新可跑的候选恢复 pending;乐观并发未命中
    //(被其它路径并发改写,如新到利空触发的 conflict_hold——含状态值相同的
    // ABA 情形,由 expectedUpdatedAt 版本比对兜住)的候选本轮不再执行
    const runnable = [];
    for (const candidate of reEligible) {
      // 资金未释放期间 capital_constrained 不复评:复位后必然再走一遍
      // decideTrade+风控官然后被同一预算约束拒绝,白烧两次 LLM 调用
      if (candidate.status === 'capital_constrained' && !capitalFreed) continue;
      if (candidate.status !== 'pending') {
        const ok = await updateCandidate(
          candidate.id,
          { status: 'pending', status_reason: '复评后恢复待分配' },
          { expectedStatus: candidate.status, expectedUpdatedAt: candidate.updated_at }
        );
        if (!ok) continue;
        candidate.status = 'pending';
        candidate.updated_at = ok;
      }
      runnable.push(candidate);
    }

    // 同票合并 → 排名 → 取前 N 执行
    const { merged, absorbed } = mergeBySymbol(runnable);
    const ranked = rankCandidates(merged);
    const planned = planAllocations({
      ranked,
      maxPerRun: config.maxAllocationsPerRun,
    });
    if (!planned.length) return;
    console.log(
      `[allocator] 本轮(${trigger})候选 ${candidates.length} → 可执行 ${merged.length},执行前 ${planned.length} 个: ${planned.map((c) => `${c.symbol}(${c.score})`).join(' ')}${regime.clamped ? '(确定性核验钳制 risk_on 放大)' : ''}`
    );

    let allocated = 0;
    let halted = false;
    // 止盈腾位闸:每轮最多腾位一次(尝试即计数,失败也算),避免一轮内连环清仓
    let rotated = false;
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
      // 宏观乘数 × 行业乘数 × 冲突缩仓:三者共同作为分配路径的额外仓位缩放
      //(打分里它们只影响排序,这里才真正进入买入金额)。
      // 宏观分量(macroScale)单独传递:no_macro_filter 影子变体镜像时只还原这部分
      const macroScale = Number(
        ((Number(params.macroMultiplier) || 1) * (Number(candidate.sectorMult) || 1)).toFixed(4)
      );
      const extraScale = Number(
        (macroScale * (conflictScale ? conflictScale.scale : 1)).toFixed(4)
      );
      let result;
      try {
        result = await executeCandidate(candidate, {
          macroContext,
          extraScale,
          macroScale,
        });
      } catch (err) {
        console.warn(`[allocator] ${candidate.symbol} 执行失败(候选留池): ${err.message}`);
        continue;
      }

      // 止盈腾位(选盈利票机制):好候选被容量/现金类约束拒绝时,全仓止盈一个
      // 最接近止盈价的盈利持仓,腾出容量后立即重试该候选一次;
      // 无盈利持仓/卖出失败则落回原 capital_constrained 流程
      if (!result?.trade && ROTATION_REASONS.has(result?.reason) && !rotated) {
        rotated = true;
        const sellTrade = await rotateProfitablePosition(candidate.symbol, result.reason);
        if (sellTrade) {
          if (Number.isFinite(cashNow)) cashNow += Number(sellTrade.amount) || 0;
          try {
            result = await executeCandidate(candidate, { macroContext, extraScale, macroScale });
          } catch (err) {
            console.warn(`[allocator] ${candidate.symbol} 腾位后重试失败(候选留池): ${err.message}`);
            continue;
          }
        }
      }

      if (result?.trade) {
        allocated += 1;
        if (Number.isFinite(cashNow)) cashNow -= Number(result.trade.amount) || 0;
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
        // 资金/配额耗尽:本候选与排名靠后的全部(含同票被合并吸收的候选,不止本轮计划内的前 N)
        // 标记 capital_constrained 留池;同时记下现金水位闸门,资金释放/跨日前不再复评
        const fromIdx = ranked.findIndex((c) => c.id === candidate.id);
        const constrainIds = new Set(
          (fromIdx >= 0 ? ranked.slice(fromIdx) : planned.slice(i)).map((c) => c.id)
        );
        for (const a of absorbed) {
          if (constrainIds.has(a.into.id)) constrainIds.add(a.candidate.id);
        }
        for (const id of constrainIds) {
          await updateCandidate(
            id,
            { status: 'capital_constrained', status_reason: result.reject },
            { expectedStatus: 'pending' }
          );
        }
        if (Number.isFinite(cashNow)) {
          allocatorStatus.capitalGate = { cash: cashNow, day: etDayKey() };
        }
        console.log(`[allocator] 资金/配额受限(${reason}),其余候选留池等待资金释放`);
        break;
      }
      if (PER_CANDIDATE_CAPITAL_REASONS.has(reason)) {
        // 持仓数上限/单票仓位帽:平仓或估值变化后自行释放,留池复评;不影响其余候选
        await updateCandidate(
          candidate.id,
          { status: 'capital_constrained', status_reason: result.reject },
          { expectedStatus: 'pending' }
        );
        console.log(`[allocator] ${candidate.symbol} 容量受限(${reason}),候选留池复评`);
        continue;
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
 * 止盈腾位卖出:在未实现盈利且设有止盈价的持仓中,选 current_price/take_profit
 * 最大者(最接近止盈价)全仓止盈,为新候选腾出持仓容量/现金。
 * 排除候选自身同票(禁止卖 X 再买 X)。返回卖出 trade 或 null(无盈利持仓/失败)。
 */
async function rotateProfitablePosition(excludeSymbol, constraintReason) {
  let valuation;
  try {
    valuation = await getValuation();
  } catch (err) {
    console.warn(`[allocator] 止盈腾位前获取估值失败: ${err.message}`);
    return null;
  }
  // 持仓报价缺失时估值不可信,不据此做腾位决策(与 settleBuyLocked 的约定一致)
  if (valuation.missing_quotes) return null;
  const pick = pickRotationSell(valuation.positions, { excludeSymbol });
  if (!pick) {
    console.log(`[allocator] 无盈利持仓可腾位(${constraintReason}),候选按资金受限留池`);
    return null;
  }
  const reason = `止盈腾位(${constraintReason}):现价 $${pick.current_price} 最接近止盈价 $${pick.take_profit},为新候选腾出容量`;
  console.log(`[allocator] ${pick.symbol} ${reason}`);
  try {
    const trade = await executeSellOrder({
      symbol: pick.symbol,
      price: pick.current_price,
      fraction: 1,
      reason,
      trigger: 'rotation',
    });
    if (trade) broadcast('trade', trade);
    return trade || null;
  } catch (err) {
    console.warn(`[allocator] ${pick.symbol} 止盈腾位卖出失败: ${err.message}`);
    return null;
  }
}

/**
 * 批量提交刷分写入:shouldWriteScore 过滤掉无意义的纯分数写,其余 20 个一批并发,
 * 全部带乐观并发(expectedStatus=加载时状态 + expectedUpdatedAt 版本比对)。
 * 返回 { missed: 未命中候选 id 集合(已被并发修改,本轮剔除),
 *        stamped: id → 本次写入的 updated_at(调用方同步回内存快照) }。
 */
async function flushCandidateWrites(writes) {
  const missed = new Set();
  const stamped = new Map();
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
          expectedUpdatedAt: w.candidate.updated_at,
        });
        if (!ok) missed.add(w.candidate.id);
        else stamped.set(w.candidate.id, ok);
      })
    );
  }
  return { missed, stamped };
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
