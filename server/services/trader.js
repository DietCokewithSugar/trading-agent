import { supabase } from '../db.js';
import { config } from '../config.js';
import { getQuote } from './fmp.js';
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
 * 询问 DeepSeek 决策 → 校验风控约束 → 以 FMP 实时价格模拟成交 → 落库。
 * 返回成交记录,未成交返回 null。
 */
export async function handleSignal(article, analysisRow) {
  const symbol = analysisRow.symbol;
  const quote = await getQuote(symbol);
  if (!quote) {
    console.warn(`[trader] ${symbol} 无法获取报价,跳过`);
    return null;
  }

  const valuation = await getValuation();
  const decision = await decideTrade({
    analysis: analysisRow,
    article,
    quote,
    portfolio: {
      cash: valuation.cash,
      totalValue: valuation.total_value,
      positions: valuation.positions,
    },
  });

  console.log(`[trader] ${symbol} 决策: ${decision.action} fraction=${decision.fraction}`);
  if (decision.action === 'hold' || decision.fraction <= 0) return null;

  if (decision.action === 'buy') {
    return executeBuy({ symbol, quote, decision, valuation, analysisRow, article });
  }
  return executeSell({ symbol, quote, decision, valuation, analysisRow, article });
}

async function executeBuy({ symbol, quote, decision, valuation, analysisRow, article }) {
  const db = supabase();
  const price = quote.price;

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

  // 更新持仓(加权平均成本)
  const { data: pos } = await db.from('positions').select('*').eq('symbol', symbol).maybeSingle();
  if (pos) {
    const oldQty = Number(pos.quantity);
    const newQty = round4(oldQty + quantity);
    const newAvg = round4((oldQty * Number(pos.avg_cost) + amount) / newQty);
    await db
      .from('positions')
      .update({ quantity: newQty, avg_cost: newAvg, updated_at: new Date().toISOString() })
      .eq('symbol', symbol);
  } else {
    await db.from('positions').insert({ symbol, quantity, avg_cost: round4(price) });
  }

  return insertTrade(db, {
    symbol,
    side: 'buy',
    quantity,
    price,
    amount,
    reason: decision.reason,
    news_id: article.id,
    analysis_id: analysisRow.id,
    realized_pnl: null,
  });
}

async function executeSell({ symbol, quote, decision, valuation, analysisRow, article }) {
  const db = supabase();
  const price = quote.price;

  const position = valuation.positions.find((p) => p.symbol === symbol);
  if (!position || position.quantity <= 0) {
    console.log(`[trader] 未持有 ${symbol},无法卖出`);
    return null;
  }

  let quantity = round4(position.quantity * decision.fraction);
  // 余量太小则全部卖出
  if (position.quantity - quantity < 0.0001 || decision.fraction >= 0.99) {
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
    .update({ cash: round2(valuation.cash + amount), updated_at: new Date().toISOString() })
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
    reason: decision.reason,
    news_id: article.id,
    analysis_id: analysisRow.id,
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
