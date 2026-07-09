import { supabase } from '../db.js';
import { config } from '../config.js';
import { getQuote, getProfile, getMarketSession, normalizeTs } from './fmp.js';
import { minutesSinceMarketOpen } from './marketCalendar.js';
import { currentRunId, recordReject } from './metrics.js';
import { isTradingHalted } from './tradingHalt.js';
import {
  evaluateDailyLossHalt,
  checkMaxPositions,
  sectorCapHeadroom,
  getLossStreakMultiplier,
  computeBuyHeadroom,
  getDailyBuySpent,
  getDailyBudgetBase,
  noteBuySpent,
  getNewPositionsToday,
  noteNewPositionOpened,
} from './riskControls.js';
import { getRegime, getEffectiveRegime } from './macroRegime.js';
import { decideTrade, reviewProposedTrade } from './deepseek.js';
import { getPortfolio, getValuation } from './portfolio.js';
import { reflectOnClosedTrade, getMemories } from './memoryService.js';
import { computeFill, computePoolMetrics } from './execution.js';
import { checkBuyEligibility } from './eligibility.js';
import { getReferenceForEligibility } from './symbolReference.js';
import { isSymbolHalted } from './tradingHalts.js';
import { scaleFraction } from './sizing.js';
import { enqueuePendingOrder } from './openQueue.js';
import {
  enqueueCandidate,
  findActiveCandidate,
  mergeIntoCandidate,
  holdBuyCandidates,
  isPoolAvailable,
  getCandidateStatus,
} from './candidateStore.js';
import { scoreCandidate } from './allocator.js';
import { checkTradeCooldown } from './eventService.js';
import {
  onBullishSignal,
  onBearishSignal,
  onOfficerVeto,
  onMacroClampedBuy,
  mirrorBuy,
  mirrorSell,
} from './shadowPortfolio.js';
import { beginDecisionEpisode, attachOfficer, finishDecision } from './decisionLog.js';
import { bumpTakeProfit } from './holding.js';
import { mirrorTrade } from './brokerMirror.js';
import { computeSymbolBracket } from './volatility.js';
import { getTradingStrategy, isEntryPathStrategy, strategyBracket } from './strategy.js';
import { pickRotationSell } from './rotation.js';
import { broadcast } from './bus.js';

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * 买入 bracket 赋值(023/024,按当前策略):default 与 immediate 类/等权策略固定 ±config;
 * wide_bracket ±4%;trailing_only 止损同距、不设止盈;vol_bracket 按 20 日波动缩放
 * (波动不可算回退固定值)。无论策略,波动与"应然 bracket"都记在 decision 上:
 * 成交后落 trades(证据链),并传给 vol_bracket 影子变体——对照实验照常积累。
 */
async function applyBracket(decision, symbol) {
  const vb = await computeSymbolBracket(symbol);
  const strategy = getTradingStrategy();
  const bracket = strategyBracket(strategy, { volBracketPercent: vb.bracketPercent, cfg: config });
  decision.stopLossPercent = bracket.stopLossPercent;
  decision.takeProfitPercent = bracket.takeProfitPercent;
  decision.bracketVol = vb.volPercent;
  decision.volBracketPercent = vb.bracketPercent;
  if (strategy === 'vol_bracket' && vb.bracketPercent !== null) {
    console.log(`[trader] ${symbol} 波动自适应敞口: 20日波动 ${vb.volPercent}% → bracket ±${vb.bracketPercent}%`);
  }
}

/**
 * 止盈腾位卖出(020,自 allocator 迁入以供即时策略共用):在未实现盈利且设有止盈价的
 * 持仓中,选 current_price/take_profit 最大者(最接近止盈价)全仓止盈,为新买入腾出
 * 持仓容量/现金。排除同票(禁止卖 X 再买 X)。返回卖出 trade 或 null(无盈利持仓/失败)。
 */
export async function rotateProfitablePosition(excludeSymbol, constraintReason) {
  let valuation;
  try {
    valuation = await getValuation();
  } catch (err) {
    console.warn(`[trader] 止盈腾位前获取估值失败: ${err.message}`);
    return null;
  }
  // 持仓报价缺失时估值不可信,不据此做腾位决策(与 settleBuyLocked 的约定一致)。
  // missing_quotes 恒为数组,须判长度——原先的真值判断让腾位永远早退(实盘腾位从未生效)
  if (valuation.missing_quotes?.length) return null;
  // 停牌票不参与腾位(028):停牌中卖不掉,按 stale price 腾位也不真实
  const pick = pickRotationSell(
    valuation.positions.filter((p) => !isSymbolHalted(p.symbol)),
    { excludeSymbol }
  );
  if (!pick) {
    console.log(`[trader] 无盈利持仓可腾位(${constraintReason})`);
    return null;
  }
  const reason = `止盈腾位(${constraintReason}):现价 $${pick.current_price} 最接近止盈价 $${pick.take_profit},为新买入腾出容量`;
  console.log(`[trader] ${pick.symbol} ${reason}`);
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
    console.warn(`[trader] ${pick.symbol} 止盈腾位卖出失败: ${err.message}`);
    return null;
  }
}

// 进程内交易互斥:新闻交易(runCycle)与止损/止盈监控(checkStops)并发运行,
// 下单段在此串行化,避免「读组合 → 算现金 → 写回」交错导致的资金竞态;
// 数据库侧 execute_trade 的行锁是第二道防线。
let tradeChain = Promise.resolve();
export function withTradeLock(fn) {
  const run = tradeChain.then(fn, fn);
  tradeChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

// 即时腾位策略可通过卖出缓解的拒绝原因(比分配器多 below_min_amount:确定性基础仓位
// ~10% 时 spend 被现金压到最小订单额之下,几乎只意味着现金耗尽,腾位正好解决;
// 极小组合腾位后仍不足 $50 的边界由"每信号只重试一次"自然终止)
const IMMEDIATE_ROTATION_REASONS = new Set(['max_positions', 'cash_reserve', 'gross_exposure', 'below_min_amount']);

/**
 * 入场路径类策略的确定性买入(024):不经候选池/LLM 决策/风控官/决策回放,
 * 仓位 = 确定性公式(immediate_* 用 shadowBaseFraction × 档位/置信/来源缩放链,
 * equal_weight 用固定比例),bracket 按当前策略(applyBracket)。
 * 休市挂开盘队列;immediate_rotation 在容量/现金类拒绝时止盈腾位一次后重试一次。
 * 返回与旧即时路径同约定:trade / { queued } / null(runCycle 零改动消费)。
 */
async function executeImmediateStrategyBuy({ article, analysisRow, profile, price }) {
  const symbol = analysisRow.symbol;
  const strategy = getTradingStrategy();
  let fraction;
  if (strategy === 'equal_weight') {
    fraction = config.shadowEqualWeightFraction;
  } else {
    const srcScore =
      article.source_score === null || article.source_score === undefined
        ? null
        : Number(article.source_score);
    fraction = scaleFraction({
      fraction: config.shadowBaseFraction,
      tier: analysisRow.tier,
      confidence: analysisRow.confidence,
      sourceScore: srcScore,
    }).sized;
  }
  const decision = {
    action: 'buy',
    fraction,
    reason: `策略「${strategy}」:信号即时成交(确定性仓位 ${fraction},不经 LLM 决策)`,
  };
  await applyBracket(decision, symbol);
  console.log(`[trader] ${symbol} ${decision.reason}`);

  // 休市:与旧即时路径一致挂开盘队列(按单持久化 bracket,入队时刻的策略生效)
  if (getMarketSession() === 'closed') {
    const pending = await enqueuePendingOrder({
      symbol,
      side: 'buy',
      fraction: decision.fraction,
      ref_price: round4(price),
      stop_loss_percent: decision.stopLossPercent,
      take_profit_percent: decision.takeProfitPercent,
      reason: decision.reason,
      news_id: article.id,
      analysis_id: analysisRow.id,
    });
    if (pending) return { queued: true, pending };
  }

  const meta = { run_id: currentRunId() };
  let result = await executeBuyStructured({ symbol, price, decision, analysisRow, article, meta });
  // 即时腾位:容量/现金类拒绝 → 全仓止盈最接近止盈价的盈利持仓,重试一次
  if (
    strategy === 'immediate_rotation' &&
    !result?.trade &&
    IMMEDIATE_ROTATION_REASONS.has(result?.reason)
  ) {
    const sellTrade = await rotateProfitablePosition(symbol, result.reason);
    if (sellTrade) {
      result = await executeBuyStructured({ symbol, price, decision, analysisRow, article, meta });
    }
  }
  if (result?.trade) return result.trade;
  console.log(`[trader] ${symbol} 即时策略买入跳过: ${result?.reject || result?.reason || '未知'}`);
  recordReject(result?.reason || 'immediate_strategy_reject');
  return null;
}

/** 风控官的组合级上下文:持仓/行业权重 + 最近卖出盈亏(在交易锁外构建) */
async function buildRiskContext(valuation) {
  const total = valuation.total_value;
  const positionWeights = valuation.positions.map((p) => ({
    代码: p.symbol,
    权重百分比: total > 0 ? Math.round((p.market_value / total) * 1000) / 10 : 0,
  }));

  // 行业分布:公司档案缓存 24 小时,这里基本不产生额外 FMP 请求
  const sectorValues = new Map();
  for (const p of valuation.positions) {
    const profile = await getProfile(p.symbol).catch(() => null);
    const sector = profile?.sector || '未知';
    sectorValues.set(sector, (sectorValues.get(sector) || 0) + p.market_value);
  }
  const sectorWeights = [...sectorValues.entries()].map(([sector, value]) => ({
    行业: sector,
    权重百分比: total > 0 ? Math.round((value / total) * 1000) / 10 : 0,
  }));

  // 最近 5 笔卖出盈亏:连续亏损时风控官应整体降敞口
  let recentSells = [];
  const { data: sells, error } = await supabase()
    .from('trades')
    .select('symbol, realized_pnl, created_at')
    .eq('side', 'sell')
    .not('realized_pnl', 'is', null)
    .order('created_at', { ascending: false })
    .limit(5);
  if (!error) {
    recentSells = (sells || []).map((t) => ({
      代码: t.symbol,
      盈亏: Number(t.realized_pnl),
    }));
  }

  return { positionWeights, sectorWeights, recentSells };
}

/** execute_trade RPC 尚未部署(未执行 004 迁移)时的判定 */
function isMissingTradeRpc(error) {
  return error?.code === 'PGRST202' || /execute_trade/.test(error?.message || '');
}

function logTrade(trade) {
  console.log(
    `[trader] 成交: ${trade.side === 'buy' ? '买入' : '卖出'} ${trade.symbol} ${trade.quantity} 股 @ $${trade.price}`
  );
  return trade;
}

// 008/012 迁移未执行(trades 缺成交明细/时间线列)时逐列降级,各列只告警一次
const missingFillColumns = new Set();

/** 成交所用报价自带的时间戳(ISO),报价缺失或无时间戳时为 null */
function quoteTimestampOf(quote) {
  const ts = normalizeTs(quote?.timestamp);
  return ts ? new Date(ts).toISOString() : null;
}

/**
 * 成交后补写明细(市场参考价/滑点 + run_id/决策窗口/报价时间戳),best-effort:
 * RPC 路径的 trades 行由数据库函数插入,这些可选列只能事后补写;列缺失时逐列降级忽略。
 */
async function recordFillDetails(trade, fill, extras = {}) {
  if (!trade) return trade;
  const candidates = {
    ...(fill ? { quote_price: round4(fill.refPrice), slippage_bps: fill.slippageBps } : {}),
    ...extras,
  };
  const payload = {};
  for (const [col, value] of Object.entries(candidates)) {
    if (value !== null && value !== undefined && !missingFillColumns.has(col)) payload[col] = value;
  }
  if (!Object.keys(payload).length) return trade;
  try {
    let { data, error } = await supabase()
      .from('trades')
      .update(payload)
      .eq('id', trade.id)
      .select()
      .single();
    while (error && /column|schema/i.test(error.message)) {
      const col = Object.keys(payload).find((c) => error.message.includes(c));
      if (!col) break;
      missingFillColumns.add(col);
      console.warn(`[trader] trades 缺少 ${col} 列,已降级不记录(请执行 008/012 迁移)`);
      delete payload[col];
      if (!Object.keys(payload).length) return trade;
      ({ data, error } = await supabase()
        .from('trades')
        .update(payload)
        .eq('id', trade.id)
        .select()
        .single());
    }
    if (error) {
      console.warn(`[trader] 写入成交明细失败: ${error.message}`);
      return trade;
    }
    return data;
  } catch (err) {
    console.warn(`[trader] 写入成交明细失败: ${err.message}`);
    return trade;
  }
}

/**
 * 处理一条可交易的新闻分析信号:
 * 拉取报价 + 公司档案做标的核验 → 询问 DeepSeek 决策 → 校验风控约束 →
 * 以 FMP 实时价格(含盘前盘后)模拟成交 → 落库。
 * 返回成交记录,未成交返回 null。
 */
export async function handleSignal(article, analysisRow) {
  const symbol = analysisRow.symbol;

  const [quote, profile] = await Promise.all([getQuote(symbol), getProfile(symbol)]);
  if (!quote) {
    console.warn(`[trader] ${symbol} 无法获取报价,跳过`);
    recordReject('no_quote');
    return null;
  }
  // 硬校验:档案明确显示该代码当前并未正常交易(退市/停牌)时直接跳过
  if (profile && profile.isActivelyTrading === false) {
    console.warn(`[trader] ${symbol} 当前未在正常交易(isActivelyTrading=false),跳过`);
    recordReject('not_actively_trading');
    return null;
  }
  const price = quote.effective_price ?? quote.price;

  if (analysisRow.sentiment === 'bullish') {
    // 标的准入门槛(只拦做多):最小市值/最低股价/最低日均美元成交额 + 上市名录校验(028),
    // 入池/决策之前硬性拦截,微盘/低流动性/名录外的利好新闻连候选资格都没有。
    // 停牌不在此拦:入池免费且正确(复牌后分配器重评,24h 过期自然兜底),
    // 买入执行由 settleBuyLocked 的 symbol_halted transient reject 总闸把守
    const gate = checkBuyEligibility({ profile, price, reference: getReferenceForEligibility(symbol) });
    if (!gate.ok) {
      console.log(`[trader] ${symbol} 未过标的准入门槛,跳过: ${gate.reason}`);
      recordReject('eligibility_gate');
      return null;
    }

    // 影子组合(017,fire-and-forget):信号即时成交/等权买入等独立变体在此记账,
    // 与实盘走不走候选池无关——它们消融的正是候选池+LLM 决策链本身
    onBullishSignal({ article, analysisRow, quote, profile, price });

    // 入场路径类策略(024,管理页切换):信号到达即确定性建仓,绕过同票刷新/候选池/
    // LLM 决策/风控官——但 settleBuyLocked 的全部锁内硬风控照常生效(安全线永不绕过)
    if (isEntryPathStrategy(getTradingStrategy())) {
      return executeImmediateStrategyBuy({ article, analysisRow, profile, price });
    }

    // 同票新利好刷新(020):已持有该票时不再入池加仓,确定性刷新持有时钟并上抬止盈线。
    // 上游已保证一/二档(TRADE_TIER_THRESHOLD)、置信度 ≥0.5、事件级去重(同一事件的
    // 重复报道到不了这里,满足"须为不同利好"的相似度要求)与综合置信度门槛;
    // 放在准入门槛之后——基本面/流动性恶化的持有票不因新闻续命。
    // 刷新写入失败 fail-closed:事件不消费(等下一报道重试),也不退回入池路径
    const refresh = await refreshHeldPositionOnBullish({ symbol, analysisRow });
    if (refresh === 'refreshed') return { refreshed: true };
    if (refresh === 'failed') return null;

    // 候选入池(014):利好信号不再先到先得即时成交,而是进候选池由资金分配器
    // 统一打分排序后分配资金——信号时刻不发起任何 LLM 交易决策调用。
    // 入池失败(表缺失/未启用宏观)退回下方的旧即时交易路径,信号不丢
    const pooled = await poolBullishSignal({ article, analysisRow, profile, price });
    if (pooled) return { pooled: true, candidate: pooled };

    // ── 以下为旧即时交易路径(候选池不可用时的退路)──
    // 人工交易暂停开关:确定性预检先行,省一次 LLM 决策调用
    if (isTradingHalted()) {
      console.log(`[trader] ${symbol} 交易暂停开关已开启(人工),跳过做多信号`);
      recordReject('trading_halted');
      return null;
    }
  } else if (analysisRow.sentiment === 'bearish') {
    // 同票多空冲突:利空信号到达即冻结池中买入候选(conflict_hold 非终态,
    // 信号出冲突窗口后由分配器复评;fail-open,失败仅告警)
    await holdBuyCandidates(symbol, '同票利空信号触发冲突搁置');
    // 影子组合:独立变体(即时成交/等权)收到利空即清仓同票
    onBearishSignal({ analysisRow, quote, price });

    // 确定性利空清仓:一/二档利空(上游已按档位/置信度/事件去重把关)且已持有 →
    // 不经 LLM 立即全仓卖出;未持有 → 只做多无仓可卖,直接结束(省一次 LLM 决策)
    return sellHeldPositionOnBearish({ symbol, price, analysisRow, article });
  }

  const valuation = await getValuation();

  // 组合级硬风控预检(只拦做多;确定性规则先行,省一次 LLM 决策调用):
  // 当日亏损熔断 → 持仓数上限。settleBuyLocked 内还有锁内的最终防线(覆盖开盘队列)。
  // 取舍:bullish 信号理论上也可能让 LLM 给出卖出决策,预检会一并拦掉——
  // 与现有 eligibility gate 同构的已接受取舍,保护性卖出不经此路径
  if (analysisRow.sentiment === 'bullish') {
    const dailyLoss = await evaluateDailyLossHalt(valuation.total_value);
    if (dailyLoss.halted) {
      console.log(`[trader] ${symbol} 当日亏损熔断生效,今日停止开新仓,跳过`);
      recordReject('daily_loss_halt');
      return null;
    }
    const maxPos = checkMaxPositions({
      positions: valuation.positions,
      symbol,
      maxOpenPositions: config.maxOpenPositions,
    });
    if (!maxPos.ok) {
      console.log(`[trader] ${symbol} ${maxPos.reason},跳过`);
      recordReject('max_positions');
      return null;
    }
  }

  // 历史教训(FinMem 式记忆):该股票及全局的平仓复盘结论,注入决策上下文
  const memories = await getMemories(symbol);
  // 决策窗口起点:从这里到风控官审批结束,是"决策依据价格的失效窗口"(漂移熔断防的那段)
  const decisionStartedAt = new Date();
  const decision = await decideTrade({
    analysis: analysisRow,
    article,
    quote,
    profile,
    portfolio: {
      cash: valuation.cash,
      totalValue: valuation.total_value,
      positions: valuation.positions,
    },
    memories,
  });
  // 决策回放(018):从这里到流程退出,每个分支都把结局落到 trade_decisions
  const episode = beginDecisionEpisode({
    path: 'immediate',
    symbol,
    article,
    analysisRow,
    decisionPrice: price,
    decision,
    runId: currentRunId(),
  });

  if (!decision.symbolValid) {
    console.warn(`[trader] ${symbol} 标的核验未通过: ${decision.validationReason}`);
    finishDecision(episode, { outcome: 'symbol_invalid', reason: decision.validationReason });
    recordReject('symbol_invalid');
    return null;
  }
  console.log(`[trader] ${symbol} 决策: ${decision.action} fraction=${decision.fraction}`);
  if (decision.action === 'hold' || decision.fraction <= 0) {
    // 可观测性:一档利空 + 已持仓却选择不动,值得人工复核
    const held = valuation.positions.some((p) => p.symbol === symbol);
    if (held && analysisRow.sentiment === 'bearish' && analysisRow.tier === 1) {
      console.warn(`[trader] ${symbol} 一档利空且已持仓但决策为 hold: ${decision.reason}`);
    }
    finishDecision(episode, { outcome: 'hold', reason: decision.reason });
    recordReject('llm_hold');
    return null;
  }

  // 买入只允许来自利好信号:eligibility gate 只在 bullish 分支前置执行,
  // 利空/中性信号若被 LLM 决策为 buy 会绕过准入门槛(微盘/OTC 无防线),一律放弃
  if (decision.action === 'buy' && analysisRow.sentiment !== 'bullish') {
    console.warn(`[trader] ${symbol} 非利好信号(${analysisRow.sentiment})的买入决策被拦截(未过准入门槛)`);
    finishDecision(episode, { outcome: 'rejected', reason: '非利好信号的买入决策(绕过准入门槛)' });
    recordReject('buy_on_non_bullish');
    return null;
  }

  if (decision.action === 'buy') {
    // 止盈止损(代码强制,LLM 建议只留在决策回放快照):默认固定 ±config 百分比;
    // 波动自适应开关(023,管理页)开启时按 20 日波动缩放。无论开关,波动都会计算
    // 并随成交落库(证据链),同时供 vol_bracket 影子变体做对照实验
    await applyBracket(decision, symbol);

    // 仓位缩放链(按序叠加):LLM fraction → 档位/置信度/来源可信度缩放 → 风控官 scale → 硬性风控帽。
    // fraction 的基数是组合总值(受可用现金约束),而非可用现金本身——按现金比例下单
    // 会让先到的信号占大仓、后到的信号只剩零头,仓位大小取决于新闻先后而非信号强弱。
    const srcScore =
      article.source_score === null || article.source_score === undefined
        ? null
        : Number(article.source_score);
    const { sized, tierMult, confMult, srcMult } = scaleFraction({
      fraction: decision.fraction,
      tier: analysisRow.tier,
      confidence: analysisRow.confidence,
      sourceScore: srcScore,
    });
    if (sized !== decision.fraction) {
      console.log(
        `[trader] ${symbol} 仓位缩放: ${decision.fraction} × 档位${tierMult} × 置信度${confMult} × 来源${srcMult} → ${sized}`
      );
      decision.fraction = sized;
    }
    episode.sizing.signal_scaled = sized;

    // 连亏降仓(确定性规则,先于风控官,缩放后的 fraction 对风控官可见):
    // 最近 N 笔卖出全部亏损说明当前判断系统性失准,买入比例打折
    const streakMult = await getLossStreakMultiplier();
    if (streakMult < 1) {
      const cut = round4(decision.fraction * streakMult);
      console.log(
        `[trader] ${symbol} 连亏降仓 ×${streakMult}: ${decision.fraction} → ${cut}(最近 ${config.lossStreakCount} 笔卖出均亏损)`
      );
      decision.fraction = cut;
    }
    episode.sizing.streak_mult = streakMult;

    // 风控官审批(TradingAgents 式独立风控):站在组合角度复核这笔买入,
    // 可放行/缩仓/否决。审批调用失败时 fail-closed 放弃买入(与去重失败即跳过的约定一致)。
    // 否决前方案与缩仓系数同时喂给影子组合:no_risk_officer 变体消融的正是这一层
    const preOfficerFraction = decision.fraction;
    let officerScale = 1;
    if (config.enableRiskOfficer) {
      try {
        const context = await buildRiskContext(valuation);
        const verdict = await reviewProposedTrade({
          proposal: {
            symbol,
            price,
            fraction: decision.fraction,
            estimatedSpend: round2(
              Math.min(decision.fraction * valuation.total_value, valuation.cash)
            ),
            stopLossPercent: decision.stopLossPercent,
            takeProfitPercent: decision.takeProfitPercent,
            reason: decision.reason,
          },
          analysis: analysisRow,
          sourceScore: srcScore,
          portfolio: {
            cash: valuation.cash,
            totalValue: valuation.total_value,
            positionWeights: context.positionWeights,
            sectorWeights: context.sectorWeights,
            recentSells: context.recentSells,
          },
          memories,
        });
        attachOfficer(episode, verdict);
        if (!verdict.approve) {
          console.warn(`[riskofficer] 否决 ${symbol} 买入: ${verdict.reason}`);
          onOfficerVeto({
            symbol,
            quote,
            profile,
            price,
            fraction: preOfficerFraction,
            stopLossPercent: decision.stopLossPercent,
            takeProfitPercent: decision.takeProfitPercent,
            vetoReason: verdict.reason,
            article,
            analysisRow,
          });
          finishDecision(episode, { outcome: 'vetoed', reason: verdict.reason });
          recordReject('risk_officer_veto');
          return null;
        }
        if (verdict.scale < 1) {
          const scaled = round4(decision.fraction * verdict.scale);
          console.log(
            `[riskofficer] ${symbol} 缩仓 ×${verdict.scale}: ${decision.fraction} → ${scaled}(${verdict.reason})`
          );
          decision.fraction = scaled;
          officerScale = verdict.scale;
        }
        // 止盈止损为固定 ±config 百分比,不再采纳风控官的止损调整(verdict 仍完整落库)
        if (verdict.reason) {
          decision.reason = `${decision.reason};风控官:${verdict.reason}`.slice(0, 300);
        }
      } catch (err) {
        console.warn(`[riskofficer] ${symbol} 审批失败,放弃本次买入: ${err.message}`);
        onOfficerVeto({
          symbol,
          quote,
          profile,
          price,
          fraction: preOfficerFraction,
          stopLossPercent: decision.stopLossPercent,
          takeProfitPercent: decision.takeProfitPercent,
          vetoReason: '风控官审批失败(fail-closed)',
          article,
          analysisRow,
        });
        finishDecision(episode, { outcome: 'officer_error', reason: err.message });
        recordReject('risk_officer_error');
        return null;
      }
    }
    episode.sizing.officer_scale = officerScale;
    if (decision.fraction <= 0) {
      onOfficerVeto({
        symbol,
        quote,
        profile,
        price,
        fraction: preOfficerFraction,
        stopLossPercent: decision.stopLossPercent,
        takeProfitPercent: decision.takeProfitPercent,
        vetoReason: '缩放后仓位归零',
        article,
        analysisRow,
      });
      finishDecision(episode, { outcome: 'vetoed', reason: '缩放后仓位归零' });
      recordReject('risk_officer_veto');
      return null;
    }
    episode.sizing.final_fraction = decision.fraction;

    // 执行时间线:run_id + 决策窗口随成交记录落库(挂单路径不带,队列成交无运行上下文)
    const meta = {
      run_id: currentRunId(),
      decision_started_at: decisionStartedAt.toISOString(),
      decision_finished_at: new Date().toISOString(),
    };

    // 休市时段不按 stale 收盘价成交:真实世界里隔夜新闻只能在次日开盘竞价成交,
    // 隔夜跳空应由市场兑现而不是被模拟盘白捡。信号挂入开盘队列,
    // 下一个常规时段以开盘价(含盘中滑点)成交;盘前盘后有真实成交价,仍立即成交。
    if (getMarketSession() === 'closed') {
      const pending = await enqueuePendingOrder({
        symbol,
        side: 'buy',
        fraction: decision.fraction,
        ref_price: round4(price),
        stop_loss_percent: decision.stopLossPercent,
        take_profit_percent: decision.takeProfitPercent,
        reason: decision.reason,
        news_id: article.id,
        analysis_id: analysisRow.id,
      });
      // 入队失败(010 迁移未执行等)退回旧行为:按休市价立即成交,信号不丢
      if (pending) {
        finishDecision(episode, { outcome: 'queued', reason: '休市,挂入开盘队列' });
        return { queued: true, pending };
      }
    }
    const result = await executeBuyStructured({
      symbol,
      price,
      decision,
      analysisRow,
      article,
      meta,
      shadowCtx: { officerScale },
    });
    if (result?.trade) {
      finishDecision(episode, { outcome: 'executed', trade: result.trade });
      return result.trade;
    }
    console.log(`[trader] ${symbol} 买入跳过: ${result?.reject}`);
    finishDecision(episode, { outcome: 'rejected', reason: result?.reject || result?.reason });
    return null;
  }

  if (getMarketSession() === 'closed') {
    const pending = await enqueuePendingOrder({
      symbol,
      side: 'sell',
      fraction: decision.fraction,
      ref_price: round4(price),
      reason: decision.reason,
      news_id: article.id,
      analysis_id: analysisRow.id,
    });
    if (pending) {
      finishDecision(episode, { outcome: 'queued', reason: '休市,挂入开盘队列' });
      return { queued: true, pending };
    }
  }
  const sellTrade = await executeSellOrder({
    symbol,
    price,
    fraction: decision.fraction,
    reason: decision.reason,
    trigger: 'news',
    news_id: article.id,
    analysis_id: analysisRow.id,
    meta: {
      run_id: currentRunId(),
      decision_started_at: decisionStartedAt.toISOString(),
      decision_finished_at: new Date().toISOString(),
    },
  });
  finishDecision(
    episode,
    sellTrade
      ? { outcome: 'executed', trade: sellTrade }
      : { outcome: 'sell_skipped', reason: '未持有该股票或卖出金额低于下限' }
  );
  return sellTrade;
}

// hold_refreshed_at 列缺失(未执行 020 迁移)时停用持有时钟刷新,只警告一次
let holdColumnUnavailable = false;

/**
 * 买入成交后刷新持有时钟(020):任何买入(新开仓/加仓/队列成交)都重置 48h 持有时限。
 * best-effort:失败只告警不影响成交;列缺失警告一次后停用。
 */
async function refreshHoldClock(symbol) {
  if (holdColumnUnavailable) return;
  const { error } = await supabase()
    .from('positions')
    .update({ hold_refreshed_at: new Date().toISOString() })
    .eq('symbol', symbol);
  if (!error) return;
  if (/hold_refreshed_at/.test(error.message)) {
    holdColumnUnavailable = true;
    console.warn('[trader] hold_refreshed_at 列不可用,持有时钟刷新停用(请执行 020 迁移)');
  } else {
    console.warn(`[trader] ${symbol} 持有时钟刷新失败: ${error.message}`);
  }
}

/**
 * 同票新利好刷新(020):已持有该票时,重置持有时钟(hold_refreshed_at)并把止盈线
 * 上抬 takeProfitStepPercent 个百分点(逐事件累加,基数为加权平均成本)。
 * 返回 'refreshed'=已刷新(调用方消费事件)/ false=未持有(走常规入池)/
 * 'failed'=持有但读写失败(fail-closed:事件不消费,下轮重试,绝不误入池加仓)。
 */
async function refreshHeldPositionOnBullish({ symbol, analysisRow }) {
  let position;
  try {
    const { data, error } = await supabase()
      .from('positions')
      .select('symbol, avg_cost, take_profit')
      .eq('symbol', symbol)
      .maybeSingle();
    if (error) throw new Error(error.message);
    position = data;
  } catch (err) {
    console.warn(`[trader] ${symbol} 利好刷新前查询持仓失败: ${err.message}`);
    return 'failed';
  }
  if (!position) return false;

  // trailing_only 策略(024)下无止盈的持仓不重建止盈线(bumpTakeProfit 对 null 会
  // 从成本价初始化一条,破坏"只靠棘轮离场"的不变量);切换前带止盈的存量持仓照常上抬
  const skipBump =
    getTradingStrategy() === 'trailing_only' &&
    (position.take_profit === null || position.take_profit === undefined);
  const newTakeProfit = skipBump
    ? null
    : bumpTakeProfit({
        takeProfit: position.take_profit,
        avgCost: position.avg_cost,
        stepPercent: config.takeProfitStepPercent,
        defaultTakeProfitPercent: config.takeProfitPercent,
      });
  const patch = { updated_at: new Date().toISOString() };
  if (!holdColumnUnavailable) patch.hold_refreshed_at = new Date().toISOString();
  if (newTakeProfit !== null && newTakeProfit !== position.take_profit) {
    patch.take_profit = newTakeProfit;
  }

  let { error } = await supabase().from('positions').update(patch).eq('symbol', symbol);
  if (error && /hold_refreshed_at/.test(error.message)) {
    // 020 未执行:去掉刷新列重试,止盈上抬仍生效(时钟刷新待迁移后可用)
    holdColumnUnavailable = true;
    console.warn('[trader] hold_refreshed_at 列不可用,持有时钟刷新停用(请执行 020 迁移)');
    const { hold_refreshed_at: _stripped, ...rest } = patch;
    ({ error } = await supabase().from('positions').update(rest).eq('symbol', symbol));
  }
  if (error) {
    console.warn(`[trader] ${symbol} 利好刷新写入失败: ${error.message}`);
    return 'failed';
  }
  console.log(
    `[trader] ${symbol} 利好刷新: 持有时钟重置,止盈 ${position.take_profit ?? '未设'} → ${newTakeProfit}(第${analysisRow.tier}档新事件)`
  );
  return 'refreshed';
}

/**
 * 确定性利空清仓:一/二档利空且已持有 → 不经 LLM 立即全仓卖出;
 * 休市时段挂入开盘队列(入队失败退回立即成交,同 010 缺失回退)。
 * trigger 沿用 'news':开盘队列卖单成交时同样落 'news'(pending_orders 无 trigger 列),
 * 两条成交路径口径一致,且同向交易冷却(checkCooldown 只统计 news)语义不变。
 * 返回 trade / { queued } / null(未持有或查询失败,事件均不消费)。
 */
async function sellHeldPositionOnBearish({ symbol, price, analysisRow, article }) {
  let held = false;
  try {
    const { data, error } = await supabase()
      .from('positions')
      .select('symbol')
      .eq('symbol', symbol)
      .maybeSingle();
    if (error) throw new Error(error.message);
    held = Boolean(data);
  } catch (err) {
    // fail-closed:读库失败不消费事件,下一报道重试(与"去重失败即跳过"同一约定)
    console.warn(`[trader] ${symbol} 利空清仓前查询持仓失败: ${err.message}`);
    return null;
  }
  if (!held) return null;

  const summary = analysisRow.event_summary || '';
  const halted = isSymbolHalted(symbol);
  const reason = `利空信号(第${analysisRow.tier}档)确定性清仓${summary ? `:${summary}` : ''}${halted ? '(停牌中,复牌后成交)' : ''}`.slice(0, 300);
  // 休市或停牌(028)都无法真实成交:挂入开盘队列,复牌/开盘后按真实价成交
  //(停牌中的报价是停牌前最后一笔,照常成交等于用 stale price 不真实地逃顶)
  if (getMarketSession() === 'closed' || halted) {
    const pending = await enqueuePendingOrder({
      symbol,
      side: 'sell',
      fraction: 1,
      ref_price: round4(price),
      reason,
      news_id: article.id,
      analysis_id: analysisRow.id,
    });
    if (pending) return { queued: true, pending };
  }
  console.log(`[trader] ${symbol} ${reason}`);
  return executeSellOrder({
    symbol,
    price,
    fraction: 1,
    reason,
    trigger: 'news',
    news_id: article.id,
    analysis_id: analysisRow.id,
    meta: { run_id: currentRunId() },
  });
}

/**
 * 利好信号入候选池(无任何 LLM 调用):打基础分、记宏观快照、记入池时市场价
 * (entry_price,016:排队成本度量的基准),同票已有待开盘卖单的出生即冲突搁置。
 * 表缺失/未启用返回 null,调用方退回即时路径。
 */
async function poolBullishSignal({ article, analysisRow, profile, price = null }) {
  if (!isPoolAvailable()) return null;
  const symbol = analysisRow.symbol;

  const baseScore = scoreCandidate(
    {
      tier: analysisRow.tier,
      confidence: analysisRow.confidence,
      source_score: article.source_score ?? null,
      created_at: new Date().toISOString(),
    },
    { now: new Date() }
  );

  // 同票已有活跃候选(022):不再插行,合并进已有候选(更强信号刷新字段,
  // 事件计数/时效锚点续命;状态与入池价锚点保持)。合并写落空(利空
  // holdBuyCandidates/分配器并发写赢)也视同已入池——同票已在池,
  // fail-closed 不插重复行,返回 truthy 让 runCycle 照常消费事件
  const existing = await findActiveCandidate(symbol);
  if (existing) {
    const merged = await mergeIntoCandidate(existing, {
      news_id: article.id,
      analysis_id: analysisRow.id,
      event_id: analysisRow.event_id ?? null,
      tier: analysisRow.tier,
      confidence: analysisRow.confidence,
      final_confidence: analysisRow.final_confidence ?? null,
      source_score: article.source_score ?? null,
      sector: profile?.sector ?? null,
      base_score: baseScore,
    });
    return merged || existing;
  }

  // 出生即冲突:同票存在待开盘卖单(方向已明确要离场);查询失败按无冲突处理(fail-open)
  let conflict = false;
  try {
    const { data } = await supabase()
      .from('pending_orders')
      .select('id')
      .eq('symbol', symbol)
      .eq('side', 'sell')
      .eq('status', 'pending')
      .limit(1);
    conflict = Boolean(data?.length);
  } catch {
    conflict = false;
  }

  return enqueueCandidate({
    symbol,
    side: 'buy',
    news_id: article.id,
    analysis_id: analysisRow.id,
    event_id: analysisRow.event_id ?? null,
    tier: analysisRow.tier,
    sentiment: analysisRow.sentiment,
    confidence: analysisRow.confidence,
    final_confidence: analysisRow.final_confidence ?? null,
    source_score: article.source_score ?? null,
    sector: profile?.sector ?? null,
    base_score: baseScore,
    current_score: baseScore,
    macro_regime: getRegime().regime,
    entry_price: Number.isFinite(Number(price)) && Number(price) > 0 ? round4(Number(price)) : null,
    status: conflict ? 'conflict_hold' : 'pending',
    status_reason: conflict ? '同票存在待开盘卖单,入池即冲突搁置' : null,
  });
}

/**
 * 分配时刻执行一个买入候选(由资金分配器在盘中调用,LLM 交易决策只在这里发生):
 * 重取报价/档案 → 准入复查 → 冷却复查 → decideTrade(含宏观上下文)→ 仓位缩放链
 * (档位/置信/来源 → 宏观/行业/冲突缩放 → 连亏)→ 风控官 → 锁内结算(含预算/保留/敞口)。
 * 返回 { trade } | { reject, transient?, reason }(reason 供分配器落候选状态)。
 */
export async function executeCandidate(candidate, { macroContext = null, extraScale = 1, macroScale = 1 } = {}) {
  const symbol = candidate.symbol;

  // 候选关联的原文与分析行(决策上下文);缺失说明数据被清理,候选作废
  const [articleRes, analysisRes] = await Promise.all([
    supabase().from('news_articles').select('*').eq('id', candidate.news_id).maybeSingle(),
    supabase().from('news_analyses').select('*').eq('id', candidate.analysis_id).maybeSingle(),
  ]);
  const article = articleRes?.data;
  const analysisRow = analysisRes?.data;
  if (!article || !analysisRow) {
    return { reject: '候选关联的新闻/分析记录已不存在', reason: 'candidate_orphan' };
  }

  const [quote, profile] = await Promise.all([getQuote(symbol), getProfile(symbol)]);
  if (!quote) {
    recordReject('no_quote');
    return { reject: '无法获取报价', transient: true, reason: 'no_quote' };
  }
  if (profile && profile.isActivelyTrading === false) {
    recordReject('not_actively_trading');
    return { reject: '标的未在正常交易', reason: 'not_actively_trading' };
  }
  const price = quote.effective_price ?? quote.price;

  // 准入门槛复查:入池时过了,但市值/价格/流动性可能在池中等待期间恶化
  const gate = checkBuyEligibility({ profile, price, reference: getReferenceForEligibility(symbol) });
  if (!gate.ok) {
    recordReject('eligibility_gate');
    return { reject: `未过标的准入门槛: ${gate.reason}`, reason: 'eligibility_gate' };
  }

  // 停牌预检(028):transient 拒绝让候选留池等复牌,同时省下 decideTrade+风控官的 LLM 调用
  //(settleBuyLocked 的同名总闸仍在,这里只是省钱的前置)
  if (isSymbolHalted(symbol)) {
    recordReject('symbol_halted');
    return { reject: '停牌中,候选留池待复牌', transient: true, reason: 'symbol_halted' };
  }

  // 冷却复查:上一轮分配刚成交的同票,本轮合并后的候选不能再买
  const cooldown = await checkTradeCooldown(symbol, 'buy');
  if (!cooldown.ok) {
    recordReject('cooldown');
    return { reject: cooldown.reason, reason: 'cooldown' };
  }

  const valuation = await getValuation();
  const memories = await getMemories(symbol);
  const decisionStartedAt = new Date();
  const decision = await decideTrade({
    analysis: analysisRow,
    article,
    quote,
    profile,
    portfolio: {
      cash: valuation.cash,
      totalValue: valuation.total_value,
      positions: valuation.positions,
    },
    memories,
    macroContext,
  });
  // 决策回放(018):分配路径同样全程记录(候选 id 关联回池)
  const episode = beginDecisionEpisode({
    path: 'allocation',
    symbol,
    article,
    analysisRow,
    candidateId: candidate.id,
    decisionPrice: price,
    decision,
    runId: currentRunId(),
  });

  if (!decision.symbolValid) {
    finishDecision(episode, { outcome: 'symbol_invalid', reason: decision.validationReason });
    recordReject('symbol_invalid');
    return { reject: `标的核验未通过: ${decision.validationReason}`, reason: 'symbol_invalid' };
  }
  if (decision.action !== 'buy' || decision.fraction <= 0) {
    finishDecision(episode, { outcome: 'hold', reason: decision.reason });
    recordReject('llm_hold');
    return { reject: `决策为${decision.action}: ${decision.reason}`.slice(0, 200), reason: 'llm_hold' };
  }

  // 止盈止损(代码强制,与即时路径一致):默认固定 ±config,波动自适应开关开启时按波动缩放
  await applyBracket(decision, symbol);

  // 仓位缩放链(与即时路径同序):档位/置信度/来源 → 宏观环境(extraScale)→ 连亏 → 风控官
  const srcScore =
    article.source_score === null || article.source_score === undefined
      ? null
      : Number(article.source_score);
  const { sized, tierMult, confMult, srcMult } = scaleFraction({
    fraction: decision.fraction,
    tier: analysisRow.tier,
    confidence: analysisRow.confidence,
    sourceScore: srcScore,
  });
  if (sized !== decision.fraction) {
    console.log(
      `[allocator] ${symbol} 仓位缩放: ${decision.fraction} × 档位${tierMult} × 置信度${confMult} × 来源${srcMult} → ${sized}`
    );
    decision.fraction = sized;
  }
  episode.sizing.signal_scaled = sized;
  if (extraScale !== 1) {
    const scaled = round4(decision.fraction * extraScale);
    console.log(`[allocator] ${symbol} 宏观/行业/冲突缩放 ×${extraScale}: ${decision.fraction} → ${scaled}`);
    decision.fraction = scaled;
  }
  episode.sizing.conflict_scale = extraScale;
  const streakMult = await getLossStreakMultiplier();
  if (streakMult < 1) {
    const cut = round4(decision.fraction * streakMult);
    console.log(`[allocator] ${symbol} 连亏降仓 ×${streakMult}: ${decision.fraction} → ${cut}`);
    decision.fraction = cut;
  }
  episode.sizing.streak_mult = streakMult;

  // 否决前方案与缩仓系数同时喂给影子组合(no_risk_officer 变体消融的正是这一层)
  const preOfficerFraction = decision.fraction;
  let officerScale = 1;
  if (config.enableRiskOfficer) {
    try {
      const context = await buildRiskContext(valuation);
      const verdict = await reviewProposedTrade({
        proposal: {
          symbol,
          price,
          fraction: decision.fraction,
          estimatedSpend: round2(Math.min(decision.fraction * valuation.total_value, valuation.cash)),
          stopLossPercent: decision.stopLossPercent,
          takeProfitPercent: decision.takeProfitPercent,
          reason: decision.reason,
        },
        analysis: analysisRow,
        sourceScore: srcScore,
        portfolio: {
          cash: valuation.cash,
          totalValue: valuation.total_value,
          positionWeights: context.positionWeights,
          sectorWeights: context.sectorWeights,
          recentSells: context.recentSells,
        },
        memories,
        macroContext,
      });
      attachOfficer(episode, verdict);
      if (!verdict.approve) {
        console.warn(`[riskofficer] 否决 ${symbol} 买入: ${verdict.reason}`);
        onOfficerVeto({
          symbol,
          quote,
          profile,
          price,
          fraction: preOfficerFraction,
          stopLossPercent: decision.stopLossPercent,
          takeProfitPercent: decision.takeProfitPercent,
          vetoReason: verdict.reason,
          article,
          analysisRow,
        });
        finishDecision(episode, { outcome: 'vetoed', reason: verdict.reason });
        recordReject('risk_officer_veto');
        return { reject: `风控官否决: ${verdict.reason}`, reason: 'risk_officer_veto' };
      }
      if (verdict.scale < 1) {
        const scaled = round4(decision.fraction * verdict.scale);
        console.log(`[riskofficer] ${symbol} 缩仓 ×${verdict.scale}: ${decision.fraction} → ${scaled}(${verdict.reason})`);
        decision.fraction = scaled;
        officerScale = verdict.scale;
      }
      // 止盈止损为固定 ±config 百分比,不再采纳风控官的止损调整(verdict 仍完整落库)
      if (verdict.reason) {
        decision.reason = `${decision.reason};风控官:${verdict.reason}`.slice(0, 300);
      }
    } catch (err) {
      console.warn(`[riskofficer] ${symbol} 审批失败,放弃本次买入: ${err.message}`);
      onOfficerVeto({
        symbol,
        quote,
        profile,
        price,
        fraction: preOfficerFraction,
        stopLossPercent: decision.stopLossPercent,
        takeProfitPercent: decision.takeProfitPercent,
        vetoReason: '风控官审批失败(fail-closed)',
        article,
        analysisRow,
      });
      finishDecision(episode, { outcome: 'officer_error', reason: err.message });
      recordReject('risk_officer_error');
      return { reject: '风控官审批失败(fail-closed)', reason: 'risk_officer_error' };
    }
  }
  episode.sizing.officer_scale = officerScale;
  if (decision.fraction <= 0) {
    onOfficerVeto({
      symbol,
      quote,
      profile,
      price,
      fraction: preOfficerFraction,
      stopLossPercent: decision.stopLossPercent,
      takeProfitPercent: decision.takeProfitPercent,
      vetoReason: '缩放后仓位归零',
      article,
      analysisRow,
    });
    finishDecision(episode, { outcome: 'vetoed', reason: '缩放后仓位归零' });
    recordReject('risk_officer_veto');
    return { reject: '缩放后仓位归零', reason: 'risk_officer_veto' };
  }
  episode.sizing.final_fraction = decision.fraction;

  const result = await executeBuyStructured({
    symbol,
    price,
    decision,
    analysisRow,
    article,
    meta: {
      run_id: currentRunId(),
      decision_started_at: decisionStartedAt.toISOString(),
      decision_finished_at: new Date().toISOString(),
    },
    // 排队成本度量(016):入池价/入池时间随单传递,成交后算漂移与等待时长
    pool: { entryPrice: candidate.entry_price ?? null, enteredAt: candidate.created_at ?? null },
    // 宏观分量单独随单传递:no_macro_filter 镜像时只还原宏观/行业乘数,保留冲突/风控官缩放
    shadowCtx: { officerScale, macroScale },
    // 锁内结算前最后一次状态复核:decideTrade+风控官的长 LLM 窗口(最长两次 90s)期间
    // 新到利空可能已把候选改为 conflict_hold,不能对着刚出利空的票继续买入。
    // 读取失败(null)不据此阻断——分配器侧刚核验过,瞬时读库失败不应杀掉买入
    preSettleCheck: async () => {
      const status = await getCandidateStatus(candidate.id);
      if (status && status !== 'pending') return { ok: false, status };
      return { ok: true };
    },
  });
  finishDecision(
    episode,
    result?.trade
      ? { outcome: 'executed', trade: result.trade }
      : { outcome: 'rejected', reason: result?.reject || result?.reason }
  );
  return result;
}

/** 买入下单(结构化返回):漂移熔断 → 锁内结算。返回 { trade } | { reject, transient?, reason } */
async function executeBuyStructured({ symbol, price, decision, analysisRow, article, meta = null, pool = null, shadowCtx = null, preSettleCheck = null }) {
  return withTradeLock(async () => {
    // 下单前重取最新报价:DeepSeek 决策(最长两次 90s 调用)耗时较长,
    // 决策前的价格可能已过期,绝不能按"消息发布瞬间的价格"成交
    const quote = await getQuote(symbol, 0).catch(() => null);
    if (!quote) {
      console.warn(`[trader] ${symbol} 下单时无法获取最新报价,放弃买入(fail-closed)`);
      recordReject('no_quote');
      return { reject: '下单时无法获取最新报价', transient: true, reason: 'no_quote' };
    }

    // 漂移熔断:最新价相对决策时价格偏移过大,LLM 决策依据已失效
    //(上漂=追 spike 顶部,下漂=行情已反转),放弃本次买入
    const fresh = quote.effective_price ?? quote.price;
    const driftPct = Math.abs(fresh / price - 1) * 100;
    if (driftPct > config.buyPriceDriftAbortPercent) {
      console.warn(
        `[trader] ${symbol} 下单时价格漂移 ${round2(driftPct)}%($${price} → $${fresh})超过阈值 ${config.buyPriceDriftAbortPercent}%,放弃买入`
      );
      recordReject('price_drift_abort');
      return { reject: '下单时价格漂移超过熔断阈值', transient: true, reason: 'price_drift_abort' };
    }

    // 调用方的锁内前置复核(分配路径用于复读候选状态,关闭 LLM 决策窗口内的冲突竞态)
    if (preSettleCheck) {
      const check = await preSettleCheck();
      if (!check.ok) {
        console.log(`[trader] ${symbol} 结算前候选状态已变为 ${check.status},放弃买入`);
        recordReject('candidate_state_changed');
        return { reject: `候选状态已变为 ${check.status}`, transient: true, reason: 'candidate_state_changed' };
      }
    }

    return settleBuyLocked({
      symbol,
      quote,
      fraction: decision.fraction,
      stopLossPercent: decision.stopLossPercent,
      takeProfitPercent: decision.takeProfitPercent,
      bracketVol: decision.bracketVol ?? null,
      volBracketPercent: decision.volBracketPercent ?? null,
      reason: decision.reason,
      newsId: article.id,
      analysisId: analysisRow.id,
      meta,
      pool,
      shadowCtx,
    });
  });
}

/**
 * 开盘队列成交:休市期间挂起的买单在下一可交易时段成交——常规时段以当日开盘价,
 * 盘前/盘后以实时盘外成交价(quote.open 在盘前是上一交易日的过期开盘价,不可用)。
 * 不做漂移熔断——隔夜跳空正是这条路径要如实承担的成本;
 * 服务重启导致的延迟处理同样按开盘价回填(等价于市价开盘单)。
 * 返回 { trade } 成交 / { reject } 永久作废原因 / null 暂时失败(调用方下轮重试)。
 */
export async function executeQueuedBuy({
  symbol,
  fraction,
  stopLossPercent,
  takeProfitPercent,
  reason,
  newsId = null,
  analysisId = null,
}) {
  // 波动快照在锁外计算(1h 缓存的取数,不占交易锁):实盘成交仍用挂单时持久化的
  // 百分比(入队时刻的开关状态生效),这里只补证据链与 vol_bracket 影子变体的对照参数
  const vb = await computeSymbolBracket(symbol);
  return withTradeLock(async () => {
    const quote = await getQuote(symbol, 5_000).catch(() => null);
    if (!quote) {
      console.warn(`[trader] ${symbol} 队列成交时无法获取报价,留待下轮重试`);
      return null;
    }
    // 常规时段:当日开盘价即市价开盘单的成交基准(缺失时用最新价);
    // 盘前/盘后:用 getQuote 已合并的盘外实时成交价(effective_price)
    const open = Number(quote.open);
    const fillQuote =
      getMarketSession() === 'regular' && Number.isFinite(open) && open > 0
        ? { ...quote, effective_price: open }
        : quote;
    return settleBuyLocked({
      symbol,
      quote: fillQuote,
      fraction,
      stopLossPercent,
      takeProfitPercent,
      bracketVol: vb.volPercent,
      volBracketPercent: vb.bracketPercent,
      reason,
      newsId,
      analysisId,
    });
  });
}

/**
 * 买入下单核心(须在交易锁内调用):重取组合估值 → 硬性风控帽 → 滑点成交 → 原子落库。
 * 返回 { trade } 或 { reject: 原因 }(风控帽/最小金额拦截,属永久性拒绝)。
 */
async function settleBuyLocked({
  symbol,
  quote,
  fraction,
  stopLossPercent,
  takeProfitPercent,
  bracketVol = null,
  volBracketPercent = null,
  reason,
  newsId,
  analysisId,
  meta = null,
  pool = null,
  shadowCtx = null,
}) {
  // 影子组合:宏观硬风控拦截这笔已完成 LLM 决策的买入时,no_macro_filter 变体照样执行
  //(fire-and-forget;留池候选后续真实成交时靠 variant+analysis_id 去重防双买)
  const shadowMacroReject = (rejectReason) =>
    onMacroClampedBuy({
      symbol,
      quote,
      fraction,
      stopLossPercent,
      takeProfitPercent,
      reason: rejectReason,
      newsId,
      analysisId,
    });
  // 组合状态以下单时刻为准
  const valuation = await getValuation();

  // 持仓报价缺失时估值回退成本价,浮亏被抹平 → 当日亏损熔断/三重钳制全部失真,
  // fail-closed 暂缓买入(transient,报价恢复后下一轮重试);卖出/止损不经此路径
  if (valuation.missing_quotes?.length) {
    console.warn(
      `[trader] ${symbol} 持仓报价缺失(${valuation.missing_quotes.join('/')}),估值不可信,暂缓买入`
    );
    recordReject('valuation_unreliable');
    return { reject: '持仓报价缺失,估值不可信,暂缓买入', transient: true, reason: 'valuation_unreliable' };
  }

  // 组合级硬风控(交易锁内的最终防线,覆盖新闻买入与开盘队列成交;
  // transient 拒绝供开盘队列保留挂单重试——人工暂停/当日熔断都是临时状态)
  if (isTradingHalted()) {
    recordReject('trading_halted');
    return { reject: '交易暂停开关已开启(人工)', transient: true, reason: 'trading_halted' };
  }
  // 单票停牌守护(028):所有买入路径(即时/队列/分配/入场策略)的总闸。
  // 停牌中的报价是停牌前最后一笔,按 stale price 建仓不真实;transient 拒绝
  // 让开盘队列保留挂单、分配器保留候选,复牌后自动重试
  if (isSymbolHalted(symbol)) {
    recordReject('symbol_halted');
    return { reject: '该股票处于停牌状态,暂缓买入', transient: true, reason: 'symbol_halted' };
  }
  const dailyLoss = await evaluateDailyLossHalt(valuation.total_value);
  if (dailyLoss.halted) {
    recordReject('daily_loss_halt');
    return {
      reject: `当日亏损 ${round2(dailyLoss.dayPnlPercent ?? 0)}% 触发熔断,今日停止开新仓`,
      transient: true,
      reason: 'daily_loss_halt',
    };
  }
  const maxPos = checkMaxPositions({
    positions: valuation.positions,
    symbol,
    maxOpenPositions: config.maxOpenPositions,
  });
  if (!maxPos.ok) {
    // 持仓数上限与当日配额同类:平仓后自行解除 → transient,候选池/开盘队列保留重试
    recordReject('max_positions');
    return { reject: maxPos.reason, transient: true, reason: 'max_positions' };
  }

  const existing = valuation.positions.find((p) => p.symbol === symbol);

  // 宏观环境硬风控(014,只拦买入;regime/配额都是临时状态 → transient 供池/队列重试):
  // macro_shock 一律不开新仓;当日新开仓数配额(加仓不计)。
  // 资金参数取生效值(新闻 regime ∩ 确定性市场核验,016);regime.regime 仍为新闻
  // regime——shock 门与成交快照语义不变
  const regime = getEffectiveRegime();
  const regimeParams = regime.params;
  if (config.enableMacro) {
    if (regime.regime === 'macro_shock') {
      recordReject('macro_shock');
      shadowMacroReject('macro_shock');
      return { reject: '宏观冲击状态,暂停一切新买入', transient: true, reason: 'macro_shock' };
    }
    if (!existing && config.maxNewPositionsPerDay > 0) {
      const openedToday = await getNewPositionsToday();
      if (openedToday >= config.maxNewPositionsPerDay) {
        recordReject('new_position_quota');
        shadowMacroReject('new_position_quota');
        return {
          reject: `当日新开仓数已达上限 ${config.maxNewPositionsPerDay}`,
          transient: true,
          reason: 'new_position_quota',
        };
      }
    }
  }

  // 风控:单笔买入金额 ≤ min(决策比例×组合总值, 总资产×maxBuyCashFraction, 剩余现金)
  let spend = Math.min(
    fraction * valuation.total_value,
    config.maxBuyCashFraction * valuation.total_value,
    valuation.cash
  );

  // 风控:买入后该股票市值不超过组合总值的 maxPositionFraction
  const existingValue = existing ? existing.market_value : 0;
  const positionCap = config.maxPositionFraction * valuation.total_value - existingValue;
  spend = Math.min(spend, Math.max(positionCap, 0));
  if (spend < config.minOrderAmount && positionCap < config.minOrderAmount) {
    // 单票仓位帽钳出的不足是临时状态(减仓/行情变化后自行释放),
    // 不能落入下方的永久性 below_min_amount——候选/挂单应保留复评
    recordReject('position_cap');
    return {
      reject: `该股票仓位已接近单票上限 ${Math.round(config.maxPositionFraction * 100)}%,买入金额钳制后低于下限`,
      transient: true,
      reason: 'position_cap',
    };
  }

  // 宏观环境三重钳制:现金保留下限 / 当日买入预算(基数=日初总值)/ 持仓总敞口上限
  if (config.enableMacro) {
    const [spentToday, budgetBase] = await Promise.all([
      getDailyBuySpent(),
      getDailyBudgetBase(),
    ]);
    const headroom = computeBuyHeadroom({
      spend,
      cash: valuation.cash,
      totalValue: valuation.total_value,
      positionsValue: valuation.total_value - valuation.cash,
      spentToday,
      budgetBase,
      params: regimeParams,
    });
    if (headroom.clamped) {
      console.log(
        `[trader] ${symbol} 宏观环境(${regime.regime})钳制买入金额: $${round2(spend)} → $${round2(headroom.spend)}(约束=${headroom.binding})`
      );
      spend = headroom.spend;
      if (spend < config.minOrderAmount) {
        // 预算/保留/敞口都是当日态 → transient,候选池/开盘队列保留重试
        recordReject(headroom.binding);
        shadowMacroReject(headroom.binding);
        return {
          reject: `宏观环境额度不足(${headroom.binding}),买入金额钳制后低于下限`,
          transient: true,
          reason: headroom.binding,
        };
      }
    }
  }

  if (spend < config.minOrderAmount) {
    // 队列成交也走到这里:无运行上下文时 recordReject 为 no-op,归因误差可接受
    recordReject('below_min_amount');
    return { reject: `买入金额 ${round2(spend)} 低于下限 ${config.minOrderAmount}`, reason: 'below_min_amount' };
  }

  const profile = await getProfile(symbol).catch(() => null);

  // 风控:买后该行业市值 ≤ 组合总值的 maxSectorFraction(钳制而非否决,与 positionCap 一致;
  // 档案 24h 缓存,锁内基本不打 FMP;未知行业自成一桶)
  if (config.maxSectorFraction > 0) {
    const sector = profile?.sector || '未知';
    let sectorValue = 0;
    for (const p of valuation.positions) {
      const pp = await getProfile(p.symbol).catch(() => null);
      if ((pp?.sector || '未知') === sector) sectorValue += p.market_value;
    }
    const headroom = sectorCapHeadroom({
      totalValue: valuation.total_value,
      sectorValue,
      maxSectorFraction: config.maxSectorFraction,
    });
    if (spend > headroom) {
      console.log(
        `[trader] ${symbol} 行业(${sector})集中度钳制: $${round2(spend)} → $${round2(headroom)}`
      );
      spend = headroom;
      if (spend < config.minOrderAmount) {
        // 钳制后跌破下限:归因为行业帽而非笼统的金额下限
        recordReject('sector_cap');
        return { reject: `行业 ${sector} 集中度已达上限,买入金额钳制后低于下限`, reason: 'sector_cap' };
      }
    }
  }

  // 模拟成交:在参考价上施加不利滑点(点差/时段/开盘窗口/波动/订单冲击)
  const fill = computeFill({
    side: 'buy',
    quote,
    profile,
    notional: spend,
    minutesSinceOpen: minutesSinceMarketOpen(),
  });
  if (fill.slippageBps > 0) {
    console.log(
      `[trader] ${symbol} 买入滑点 ${fill.slippageBps}bp: $${fill.refPrice} → $${fill.fillPrice}`
    );
  }
  // 股数向下取整到 4 位小数:就近舍入的上行误差(≤0.00005 股)在高价股满现金买入时
  // 会让 amount 超出 spend 并击穿 execute_trade RPC 的 1 美分现金容差
  const quantity = Math.floor((spend / fill.fillPrice) * 1e4) / 1e4;
  const amount = round2(quantity * fill.fillPrice);

  // 候选池排队成本(016):入池价 → 成交价漂移与等待时长,评估层按此分桶
  const poolMetrics = pool
    ? computePoolMetrics({ entryPrice: pool.entryPrice, enteredAt: pool.enteredAt, fillPrice: fill.fillPrice })
    : null;
  if (poolMetrics?.entryPrice !== null && poolMetrics?.entryPrice !== undefined) {
    console.log(
      `[trader] ${symbol} 排队成本: 入池$${poolMetrics.entryPrice} → 成交$${fill.fillPrice}(漂移 ${poolMetrics.driftPercent}%,等待 ${poolMetrics.waitMinutes} 分钟)`
    );
  }

  // 执行时间线:成交所用报价自带的时间戳 + 决策窗口/run_id(队列成交无 meta,仅报价时间戳)
  // + 成交时宏观环境快照(014)+ 排队成本(016)+ bracket 宽度/波动快照(023,跨票归一)
  const extras = {
    quote_timestamp: quoteTimestampOf(quote),
    stop_loss_percent: stopLossPercent ?? null,
    take_profit_percent: takeProfitPercent ?? null,
    ...(bracketVol !== null ? { bracket_vol: bracketVol } : {}),
    ...(config.enableMacro ? { macro_regime: regime.regime } : {}),
    ...(poolMetrics
      ? {
          pool_entry_price: poolMetrics.entryPrice,
          pool_wait_minutes: poolMetrics.waitMinutes,
          pool_drift_percent: poolMetrics.driftPercent,
        }
      : {}),
    ...(meta || {}),
  };

  // 当日预算/开仓数记账(成交即记,失败路径不记)
  const noteBuyDone = () => {
    noteBuySpent(amount);
    if (!existing) noteNewPositionOpened(symbol);
  };

  // 影子组合:实盘成交镜像到跟随型变体(fire-and-forget)。
  // effectiveFraction=实际成交占组合总值比例(含全部钳制),no_risk_officer 用它还原风控官缩仓;
  // requestFraction 已含分配路径的宏观/行业乘数,随单的 macroScale 供 no_macro_filter
  // 镜像时还原宏观分量(否则恰在宏观层起作用的 regime 里,消融变体跟实盘买得一样大)
  const shadowMirror = (trade) =>
    mirrorBuy(trade, {
      effectiveFraction: valuation.total_value > 0 ? amount / valuation.total_value : 0,
      requestFraction: fraction,
      officerScale: shadowCtx?.officerScale ?? 1,
      macroScale: shadowCtx?.macroScale ?? 1,
      stopLossPercent,
      takeProfitPercent,
      volBracketPercent,
    });

  const { data, error } = await supabase().rpc('execute_trade', {
    p_symbol: symbol,
    p_side: 'buy',
    p_quantity: quantity,
    p_price: round4(fill.fillPrice),
    p_amount: amount,
    p_reason: reason,
    p_trigger: 'news',
    p_news_id: newsId,
    p_analysis_id: analysisId,
    p_stop_loss_percent: stopLossPercent,
    p_take_profit_percent: takeProfitPercent,
  });
  if (!error) {
    noteBuyDone();
    // 任何买入成交(新开/加仓/队列)都刷新 48h 持有时钟(020,best-effort)
    await refreshHoldClock(symbol);
    const trade = logTrade(await recordFillDetails(data, fill, extras));
    shadowMirror(trade);
    mirrorTrade(trade); // 券商模拟对照账本(021,fire-and-forget)
    return { trade };
  }
  if (!isMissingTradeRpc(error)) throw new Error(`买入 ${symbol} 失败: ${error.message}`);
  console.warn('[trader] execute_trade RPC 不可用,退回非事务路径(请尽快执行 004 迁移)');
  const trade = await legacyBuy({
    symbol,
    price: fill.fillPrice,
    quantity,
    amount,
    decision: { stopLossPercent, takeProfitPercent, reason },
    valuation,
    analysisRow: { id: analysisId },
    article: { id: newsId },
    fill,
    extras,
  });
  noteBuyDone();
  await refreshHoldClock(symbol);
  shadowMirror(trade);
  mirrorTrade(trade); // 券商模拟对照账本(021,fire-and-forget)
  return { trade };
}

/** 兼容尚未执行 004 迁移的数据库:旧的非事务买入路径 */
async function legacyBuy({ symbol, price, quantity, amount, decision, valuation, analysisRow, article, fill = null, extras = {} }) {
  const db = supabase();

  const { error: cashErr } = await db
    .from('portfolio_state')
    .update({ cash: round2(valuation.cash - amount), updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (cashErr) throw new Error(`更新现金失败: ${cashErr.message}`);

  // 更新持仓(加权平均成本),并按 AI 给出的百分比设定止损/止盈价
  const { data: pos } = await db.from('positions').select('*').eq('symbol', symbol).maybeSingle();
  const stops = (avgCost) => ({
    stop_loss: round4(avgCost * (1 - decision.stopLossPercent / 100)),
    take_profit: round4(avgCost * (1 + decision.takeProfitPercent / 100)),
  });
  if (pos) {
    const oldQty = Number(pos.quantity);
    const newQty = round4(oldQty + quantity);
    const newAvg = round4((oldQty * Number(pos.avg_cost) + amount) / newQty);
    await db
      .from('positions')
      .update({
        quantity: newQty,
        avg_cost: newAvg,
        ...stops(newAvg),
        updated_at: new Date().toISOString(),
      })
      .eq('symbol', symbol);
  } else {
    await db
      .from('positions')
      .insert({ symbol, quantity, avg_cost: round4(price), ...stops(price) });
  }

  return insertTrade(db, {
    symbol,
    side: 'buy',
    quantity,
    price,
    amount,
    reason: decision.reason,
    trigger: 'news',
    news_id: article.id,
    analysis_id: analysisRow.id,
    realized_pnl: null,
    ...(fill ? { quote_price: round4(fill.refPrice), slippage_bps: fill.slippageBps } : {}),
    ...extras,
  });
}

/**
 * 执行卖出并落库。新闻信号卖出与自动止损/止盈/持仓复查共用。
 * price 为决策参考价;下单时会重取最新报价并施加滑点成交,
 * 重取失败时降级用参考价继续(止损单必须能执行,不可 fail-closed)。
 * trigger: 'news' | 'stop_loss' | 'take_profit' | 'review'
 */
export async function executeSellOrder({
  symbol,
  price,
  fraction = 1,
  reason,
  trigger = 'news',
  news_id = null,
  analysis_id = null,
  meta = null,
}) {
  // 实际卖出的持仓比例(锁内确定),供影子组合等比镜像卖出
  let soldFraction = 1;
  const trade = await withTradeLock(async () => {
    // 持仓与现金以下单时刻的最新状态为准
    const val = await getValuation();

    const position = val.positions.find((p) => p.symbol === symbol);
    if (!position || position.quantity <= 0) {
      console.log(`[trader] 未持有 ${symbol},无法卖出`);
      return null;
    }

    let quantity = round4(position.quantity * fraction);
    // 余量太小则全部卖出
    if (position.quantity - quantity < 0.0001 || fraction >= 0.99) {
      quantity = position.quantity;
    }
    soldFraction = position.quantity > 0 ? quantity / position.quantity : 1;

    // 下单时重取最新报价并施加不利滑点;riskMonitor 刚取过时命中 5s 缓存,不耗配额
    const quote = await getQuote(symbol, 5_000).catch(() => null);
    let fill;
    if (quote) {
      const refPrice = quote.effective_price ?? quote.price;
      fill = computeFill({
        side: 'sell',
        quote,
        profile: await getProfile(symbol).catch(() => null),
        notional: quantity * refPrice,
        minutesSinceOpen: minutesSinceMarketOpen(),
      });
      if (fill.slippageBps > 0) {
        console.log(
          `[trader] ${symbol} 卖出滑点 ${fill.slippageBps}bp: $${fill.refPrice} → $${fill.fillPrice}`
        );
      }
    } else {
      console.warn(`[trader] ${symbol} 下单时无法获取最新报价,降级按决策参考价 $${price} 成交`);
      fill = { fillPrice: round4(price), slippageBps: null, refPrice: price };
    }

    const amount = round2(quantity * fill.fillPrice);
    if (amount < config.minOrderAmount && quantity < position.quantity) {
      console.log(`[trader] ${symbol} 卖出金额 ${amount} 低于下限,跳过`);
      return null;
    }

    // 执行时间线:报价重取失败降级用参考价时无报价时间戳
    const extras = { quote_timestamp: quoteTimestampOf(quote), ...(meta || {}) };

    const { data, error } = await supabase().rpc('execute_trade', {
      p_symbol: symbol,
      p_side: 'sell',
      p_quantity: quantity,
      p_price: round4(fill.fillPrice),
      p_amount: amount,
      p_reason: reason,
      p_trigger: trigger,
      p_news_id: news_id,
      p_analysis_id: analysis_id,
      p_stop_loss_percent: null,
      p_take_profit_percent: null,
    });
    if (!error) return logTrade(await recordFillDetails(data, fill, extras));
    if (!isMissingTradeRpc(error)) throw new Error(`卖出 ${symbol} 失败: ${error.message}`);
    console.warn('[trader] execute_trade RPC 不可用,退回非事务路径(请尽快执行 004 迁移)');
    return legacySell({ symbol, price: fill.fillPrice, quantity, amount, reason, trigger, news_id, analysis_id, val, position, fill, extras });
  });

  // 影子组合:跟随型变体按同等比例镜像卖出(覆盖新闻/止损/止盈/复查全部卖出路径)
  if (trade) {
    mirrorSell(trade, { fraction: soldFraction });
    mirrorTrade(trade); // 券商模拟对照账本(021,fire-and-forget)
  }

  // 平仓复盘:在交易锁外异步执行(LLM 调用可达 90 秒,绝不阻塞下单链路),
  // 覆盖全部卖出路径(新闻信号/自动止损/自动止盈/持仓复查)
  if (trade && trade.realized_pnl !== null && trade.realized_pnl !== undefined) {
    reflectOnClosedTrade(trade).catch((err) =>
      console.warn(`[memory] ${symbol} 平仓复盘失败: ${err.message}`)
    );
  }
  return trade;
}

/** 兼容尚未执行 004 迁移的数据库:旧的非事务卖出路径 */
async function legacySell({ symbol, price, quantity, amount, reason, trigger, news_id, analysis_id, val, position, fill = null, extras = {} }) {
  const db = supabase();
  const realizedPnl = round2((price - position.avg_cost) * quantity);

  const { error: cashErr } = await db
    .from('portfolio_state')
    .update({ cash: round2(val.cash + amount), updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (cashErr) throw new Error(`更新现金失败: ${cashErr.message}`);

  const remaining = round4(position.quantity - quantity);
  if (remaining <= 0.0001) {
    await db.from('positions').delete().eq('symbol', symbol);
  } else {
    await db
      .from('positions')
      .update({ quantity: remaining, updated_at: new Date().toISOString() })
      .eq('symbol', symbol);
  }

  return insertTrade(db, {
    symbol,
    side: 'sell',
    quantity,
    price,
    amount,
    reason,
    trigger,
    news_id,
    analysis_id,
    realized_pnl: realizedPnl,
    ...(fill ? { quote_price: round4(fill.refPrice), slippage_bps: fill.slippageBps } : {}),
    ...extras,
  });
}

// trades 的可选明细列(008/012/014/016 迁移新增),旧库缺列时逐列剥离重试
const OPTIONAL_TRADE_COLUMNS = [
  'quote_price',
  'slippage_bps',
  'quote_timestamp',
  'run_id',
  'decision_started_at',
  'decision_finished_at',
  'macro_regime',
  'pool_entry_price',
  'pool_wait_minutes',
  'pool_drift_percent',
];

async function insertTrade(db, trade) {
  const payload = { ...trade };
  let { data, error } = await db.from('trades').insert(payload).select().single();
  while (error) {
    const col = OPTIONAL_TRADE_COLUMNS.find((c) => c in payload && error.message.includes(c));
    if (!col) break;
    delete payload[col];
    ({ data, error } = await db.from('trades').insert(payload).select().single());
  }
  if (error) throw new Error(`写入交易记录失败: ${error.message}`);
  return logTrade(data);
}

export { getPortfolio };
