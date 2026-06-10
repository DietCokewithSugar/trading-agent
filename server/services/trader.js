import { supabase } from '../db.js';
import { config } from '../config.js';
import { getQuote, getProfile } from './fmp.js';
import { decideTrade, reviewProposedTrade } from './deepseek.js';
import { getPortfolio, getValuation } from './portfolio.js';
import { reflectOnClosedTrade, getMemories } from './memoryService.js';

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
    return null;
  }
  // 硬校验:档案明确显示该代码当前并未正常交易(退市/停牌)时直接跳过
  if (profile && profile.isActivelyTrading === false) {
    console.warn(`[trader] ${symbol} 当前未在正常交易(isActivelyTrading=false),跳过`);
    return null;
  }
  const price = quote.effective_price ?? quote.price;

  const valuation = await getValuation();
  // 历史教训(FinMem 式记忆):该股票及全局的平仓复盘结论,注入决策上下文
  const memories = await getMemories(symbol);
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
    return null;
  }
  console.log(`[trader] ${symbol} 决策: ${decision.action} fraction=${decision.fraction}`);
  if (decision.action === 'hold' || decision.fraction <= 0) {
    // 可观测性:一档利空 + 已持仓却选择不动,值得人工复核
    const held = valuation.positions.some((p) => p.symbol === symbol);
    if (held && analysisRow.sentiment === 'bearish' && analysisRow.tier === 1) {
      console.warn(`[trader] ${symbol} 一档利空且已持仓但决策为 hold: ${decision.reason}`);
    }
    return null;
  }

  if (decision.action === 'buy') {
    // 仓位缩放链(按序叠加):LLM fraction → 档位/置信度缩放 → 风控官 scale → 硬性风控帽。
    // 信号档位越低、置信度越低,实际动用的资金越少(Lopez-Lira:LLM 信号强度应映射到仓位)。
    const tierMult = config.tierSizeMultipliers[analysisRow.tier] ?? 0.5;
    const conf =
      analysisRow.confidence === null || analysisRow.confidence === undefined
        ? null
        : Number(analysisRow.confidence);
    // 置信度 0.5 → 0.5 倍,1.0 → 1 倍;缺失按 0.7 倍处理
    const confMult = conf === null ? 0.7 : Math.min(Math.max(conf, 0.5), 1);
    const sized = round4(decision.fraction * tierMult * confMult);
    if (sized !== decision.fraction) {
      console.log(
        `[trader] ${symbol} 仓位缩放: ${decision.fraction} × 档位${tierMult} × 置信度${confMult} → ${sized}`
      );
      decision.fraction = sized;
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
            estimatedSpend: round2(decision.fraction * valuation.cash),
            stopLossPercent: decision.stopLossPercent,
            takeProfitPercent: decision.takeProfitPercent,
            reason: decision.reason,
          },
          analysis: analysisRow,
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
        return null;
      }
    }
    if (decision.fraction <= 0) return null;
    return executeBuy({ symbol, price, decision, analysisRow, article });
  }
  return executeSellOrder({
    symbol,
    price,
    fraction: decision.fraction,
    reason: decision.reason,
    trigger: 'news',
    news_id: article.id,
    analysis_id: analysisRow.id,
  });
}

async function executeBuy({ symbol, price, decision, analysisRow, article }) {
  return withTradeLock(async () => {
    // 下单前重取组合状态:DeepSeek 决策耗时较长,决策前的快照可能已过期
    const valuation = await getValuation();

    // 风控:单笔买入金额 ≤ min(决策比例×现金, 总资产×maxBuyCashFraction, 剩余现金)
    let spend = Math.min(
      decision.fraction * valuation.cash,
      config.maxBuyCashFraction * valuation.total_value,
      valuation.cash
    );

    // 风控:买入后该股票市值不超过组合总值的 maxPositionFraction
    const existing = valuation.positions.find((p) => p.symbol === symbol);
    const existingValue = existing ? existing.market_value : 0;
    const positionCap = config.maxPositionFraction * valuation.total_value - existingValue;
    spend = Math.min(spend, Math.max(positionCap, 0));

    if (spend < config.minOrderAmount) {
      console.log(`[trader] ${symbol} 买入金额 ${round2(spend)} 低于下限,跳过`);
      return null;
    }

    const quantity = round4(spend / price);
    const amount = round2(quantity * price);

    const { data, error } = await supabase().rpc('execute_trade', {
      p_symbol: symbol,
      p_side: 'buy',
      p_quantity: quantity,
      p_price: round4(price),
      p_amount: amount,
      p_reason: decision.reason,
      p_trigger: 'news',
      p_news_id: article.id,
      p_analysis_id: analysisRow.id,
      p_stop_loss_percent: decision.stopLossPercent,
      p_take_profit_percent: decision.takeProfitPercent,
    });
    if (!error) return logTrade(data);
    if (!isMissingTradeRpc(error)) throw new Error(`买入 ${symbol} 失败: ${error.message}`);
    console.warn('[trader] execute_trade RPC 不可用,退回非事务路径(请尽快执行 004 迁移)');
    return legacyBuy({ symbol, price, quantity, amount, decision, valuation, analysisRow, article });
  });
}

/** 兼容尚未执行 004 迁移的数据库:旧的非事务买入路径 */
async function legacyBuy({ symbol, price, quantity, amount, decision, valuation, analysisRow, article }) {
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
  });
}

/**
 * 执行卖出并落库。新闻信号卖出与自动止损/止盈共用。
 * trigger: 'news' | 'stop_loss' | 'take_profit'
 */
export async function executeSellOrder({
  symbol,
  price,
  fraction = 1,
  reason,
  trigger = 'news',
  news_id = null,
  analysis_id = null,
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
    const amount = round2(quantity * price);
    if (amount < config.minOrderAmount && quantity < position.quantity) {
      console.log(`[trader] ${symbol} 卖出金额 ${amount} 低于下限,跳过`);
      return null;
    }

    const { data, error } = await supabase().rpc('execute_trade', {
      p_symbol: symbol,
      p_side: 'sell',
      p_quantity: quantity,
      p_price: round4(price),
      p_amount: amount,
      p_reason: reason,
      p_trigger: trigger,
      p_news_id: news_id,
      p_analysis_id: analysis_id,
      p_stop_loss_percent: null,
      p_take_profit_percent: null,
    });
    if (!error) return logTrade(data);
    if (!isMissingTradeRpc(error)) throw new Error(`卖出 ${symbol} 失败: ${error.message}`);
    console.warn('[trader] execute_trade RPC 不可用,退回非事务路径(请尽快执行 004 迁移)');
    return legacySell({ symbol, price, quantity, amount, reason, trigger, news_id, analysis_id, val, position });
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
async function legacySell({ symbol, price, quantity, amount, reason, trigger, news_id, analysis_id, val, position }) {
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
  });
}

async function insertTrade(db, trade) {
  const { data, error } = await db.from('trades').insert(trade).select().single();
  if (error) throw new Error(`写入交易记录失败: ${error.message}`);
  return logTrade(data);
}

export { getPortfolio };
