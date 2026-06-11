import { supabase } from '../db.js';
import { config } from '../config.js';
import { getQuote, getProfile, getMarketSession, normalizeTs } from './fmp.js';
import { currentRunId, recordReject } from './metrics.js';
import { isTradingHalted } from './tradingHalt.js';
import {
  evaluateDailyLossHalt,
  checkMaxPositions,
  sectorCapHeadroom,
  getLossStreakMultiplier,
} from './riskControls.js';
import { decideTrade, reviewProposedTrade } from './deepseek.js';
import { getPortfolio, getValuation } from './portfolio.js';
import { reflectOnClosedTrade, getMemories } from './memoryService.js';
import { computeFill } from './execution.js';
import { checkBuyEligibility } from './eligibility.js';
import { scaleFraction } from './sizing.js';
import { enqueuePendingOrder } from './openQueue.js';

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
function round2(n) {
  return Math.round(n * 100) / 100;
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

  // 人工交易暂停开关(kill switch):只拦做多信号,连报价/档案/LLM 请求都不发起。
  // 卖向信号与保护性卖出(止损/止盈/复查)完全不经此检查
  if (analysisRow.sentiment === 'bullish' && isTradingHalted()) {
    console.log(`[trader] ${symbol} 交易暂停开关已开启(人工),跳过做多信号`);
    recordReject('trading_halted');
    return null;
  }

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

  // 标的准入门槛(只拦做多):最小市值/最低股价/最低日均美元成交额,
  // 在 LLM 决策之前硬性拦截,微盘/低流动性的利好新闻连决策调用都不值得发起
  if (analysisRow.sentiment === 'bullish') {
    const gate = checkBuyEligibility({ profile, price });
    if (!gate.ok) {
      console.log(`[trader] ${symbol} 未过标的准入门槛,跳过: ${gate.reason}`);
      recordReject('eligibility_gate');
      return null;
    }
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

  if (!decision.symbolValid) {
    console.warn(`[trader] ${symbol} 标的核验未通过: ${decision.validationReason}`);
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
    recordReject('llm_hold');
    return null;
  }

  if (decision.action === 'buy') {
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

    // 风控官审批(TradingAgents 式独立风控):站在组合角度复核这笔买入,
    // 可放行/缩仓/否决。审批调用失败时 fail-closed 放弃买入(与去重失败即跳过的约定一致)。
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
        if (!verdict.approve) {
          console.warn(`[riskofficer] 否决 ${symbol} 买入: ${verdict.reason}`);
          recordReject('risk_officer_veto');
          return null;
        }
        if (verdict.scale < 1) {
          const scaled = round4(decision.fraction * verdict.scale);
          console.log(
            `[riskofficer] ${symbol} 缩仓 ×${verdict.scale}: ${decision.fraction} → ${scaled}(${verdict.reason})`
          );
          decision.fraction = scaled;
        }
        // 只接受比交易员方案更紧的止损
        if (
          verdict.adjustedStopLossPercent !== null &&
          verdict.adjustedStopLossPercent < decision.stopLossPercent
        ) {
          decision.stopLossPercent = verdict.adjustedStopLossPercent;
        }
        if (verdict.reason) {
          decision.reason = `${decision.reason};风控官:${verdict.reason}`.slice(0, 300);
        }
      } catch (err) {
        console.warn(`[riskofficer] ${symbol} 审批失败,放弃本次买入: ${err.message}`);
        recordReject('risk_officer_error');
        return null;
      }
    }
    if (decision.fraction <= 0) {
      recordReject('risk_officer_veto');
      return null;
    }

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
      if (pending) return { queued: true, pending };
    }
    return executeBuy({ symbol, price, decision, analysisRow, article, meta });
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
    if (pending) return { queued: true, pending };
  }
  return executeSellOrder({
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
}

async function executeBuy({ symbol, price, decision, analysisRow, article, meta = null }) {
  return withTradeLock(async () => {
    // 下单前重取最新报价:DeepSeek 决策(最长两次 90s 调用)耗时较长,
    // 决策前的价格可能已过期,绝不能按"消息发布瞬间的价格"成交
    const quote = await getQuote(symbol, 0).catch(() => null);
    if (!quote) {
      console.warn(`[trader] ${symbol} 下单时无法获取最新报价,放弃买入(fail-closed)`);
      recordReject('no_quote');
      return null;
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
      return null;
    }

    const result = await settleBuyLocked({
      symbol,
      quote,
      fraction: decision.fraction,
      stopLossPercent: decision.stopLossPercent,
      takeProfitPercent: decision.takeProfitPercent,
      reason: decision.reason,
      newsId: article.id,
      analysisId: analysisRow.id,
      meta,
    });
    if (result.reject) {
      console.log(`[trader] ${symbol} 买入跳过: ${result.reject}`);
      return null;
    }
    return result.trade;
  });
}

/**
 * 开盘队列成交:休市期间挂起的买单在常规时段以当日开盘价成交。
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
  return withTradeLock(async () => {
    const quote = await getQuote(symbol, 5_000).catch(() => null);
    if (!quote) {
      console.warn(`[trader] ${symbol} 队列成交时无法获取报价,留待下轮重试`);
      return null;
    }
    // 当日开盘价即市价开盘单的成交基准;开盘价缺失(刚开盘数据未就绪)用最新价
    const open = Number(quote.open);
    const fillQuote =
      Number.isFinite(open) && open > 0 ? { ...quote, effective_price: open } : quote;
    return settleBuyLocked({
      symbol,
      quote: fillQuote,
      fraction,
      stopLossPercent,
      takeProfitPercent,
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
  reason,
  newsId,
  analysisId,
  meta = null,
}) {
  // 组合状态以下单时刻为准
  const valuation = await getValuation();

  // 组合级硬风控(交易锁内的最终防线,覆盖新闻买入与开盘队列成交;
  // transient 拒绝供开盘队列保留挂单重试——人工暂停/当日熔断都是临时状态)
  if (isTradingHalted()) {
    recordReject('trading_halted');
    return { reject: '交易暂停开关已开启(人工)', transient: true };
  }
  const dailyLoss = await evaluateDailyLossHalt(valuation.total_value);
  if (dailyLoss.halted) {
    recordReject('daily_loss_halt');
    return {
      reject: `当日亏损 ${round2(dailyLoss.dayPnlPercent ?? 0)}% 触发熔断,今日停止开新仓`,
      transient: true,
    };
  }
  const maxPos = checkMaxPositions({
    positions: valuation.positions,
    symbol,
    maxOpenPositions: config.maxOpenPositions,
  });
  if (!maxPos.ok) {
    recordReject('max_positions');
    return { reject: maxPos.reason };
  }

  // 风控:单笔买入金额 ≤ min(决策比例×组合总值, 总资产×maxBuyCashFraction, 剩余现金)
  let spend = Math.min(
    fraction * valuation.total_value,
    config.maxBuyCashFraction * valuation.total_value,
    valuation.cash
  );

  // 风控:买入后该股票市值不超过组合总值的 maxPositionFraction
  const existing = valuation.positions.find((p) => p.symbol === symbol);
  const existingValue = existing ? existing.market_value : 0;
  const positionCap = config.maxPositionFraction * valuation.total_value - existingValue;
  spend = Math.min(spend, Math.max(positionCap, 0));

  if (spend < config.minOrderAmount) {
    // 队列成交也走到这里:无运行上下文时 recordReject 为 no-op,归因误差可接受
    recordReject('below_min_amount');
    return { reject: `买入金额 ${round2(spend)} 低于下限 ${config.minOrderAmount}` };
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
        return { reject: `行业 ${sector} 集中度已达上限,买入金额钳制后低于下限` };
      }
    }
  }

  // 模拟成交:在参考价上施加不利滑点(点差/时段/波动/订单冲击)
  const fill = computeFill({ side: 'buy', quote, profile, notional: spend });
  if (fill.slippageBps > 0) {
    console.log(
      `[trader] ${symbol} 买入滑点 ${fill.slippageBps}bp: $${fill.refPrice} → $${fill.fillPrice}`
    );
  }
  const quantity = round4(spend / fill.fillPrice);
  const amount = round2(quantity * fill.fillPrice);

  // 执行时间线:成交所用报价自带的时间戳 + 决策窗口/run_id(队列成交无 meta,仅报价时间戳)
  const extras = { quote_timestamp: quoteTimestampOf(quote), ...(meta || {}) };

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
    return { trade: logTrade(await recordFillDetails(data, fill, extras)) };
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

    // 下单时重取最新报价并施加不利滑点;riskMonitor 刚取过时命中 5s 缓存,不耗配额
    const quote = await getQuote(symbol, 5_000).catch(() => null);
    let fill;
    if (quote) {
      const refPrice = quote.effective_price ?? quote.price;
      fill = computeFill({ side: 'sell', quote, profile: await getProfile(symbol).catch(() => null), notional: quantity * refPrice });
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

// trades 的可选明细列(008/012 迁移新增),旧库缺列时逐列剥离重试
const OPTIONAL_TRADE_COLUMNS = [
  'quote_price',
  'slippage_bps',
  'quote_timestamp',
  'run_id',
  'decision_started_at',
  'decision_finished_at',
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
