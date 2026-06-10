import { supabase } from '../db.js';
import { config } from '../config.js';
import { getQuote, getProfile } from './fmp.js';
import { decideTrade } from './deepseek.js';
import { getPortfolio, getValuation } from './portfolio.js';

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
function round2(n) {
  return Math.round(n * 100) / 100;
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
  });

  if (!decision.symbolValid) {
    console.warn(`[trader] ${symbol} 标的核验未通过: ${decision.validationReason}`);
    return null;
  }
  console.log(`[trader] ${symbol} 决策: ${decision.action} fraction=${decision.fraction}`);
  if (decision.action === 'hold' || decision.fraction <= 0) return null;

  if (decision.action === 'buy') {
    return executeBuy({ symbol, price, decision, valuation, analysisRow, article });
  }
  return executeSellOrder({
    symbol,
    price,
    fraction: decision.fraction,
    reason: decision.reason,
    trigger: 'news',
    news_id: article.id,
    analysis_id: analysisRow.id,
    valuation,
  });
}

async function executeBuy({ symbol, price, decision, valuation, analysisRow, article }) {
  const db = supabase();

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

  // 更新现金
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
  valuation = null,
}) {
  const db = supabase();
  const val = valuation || (await getValuation());

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
  console.log(
    `[trader] 成交: ${trade.side === 'buy' ? '买入' : '卖出'} ${trade.symbol} ${trade.quantity} 股 @ $${trade.price}`
  );
  return data;
}

export { getPortfolio };
