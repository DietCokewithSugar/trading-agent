import { supabase } from '../db.js';
import { config } from '../config.js';
import { getQuotes, getMarketSession } from './fmp.js';

/** 读取(必要时初始化)资金账户与持仓 */
export async function getPortfolio() {
  const db = supabase();
  let { data: state, error } = await db
    .from('portfolio_state')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error(`读取 portfolio_state 失败: ${error.message}`);

  if (!state) {
    const { data: created, error: insErr } = await db
      .from('portfolio_state')
      .insert({ id: 1, cash: config.initialCapital, initial_capital: config.initialCapital })
      .select()
      .single();
    if (insErr) throw new Error(`初始化 portfolio_state 失败: ${insErr.message}`);
    state = created;
  }

  const { data: positions, error: posErr } = await db
    .from('positions')
    .select('*')
    .order('symbol');
  if (posErr) throw new Error(`读取 positions 失败: ${posErr.message}`);

  return { state, positions: positions || [] };
}

/** 用 FMP 实时报价为持仓估值。quoteMaxAgeMs 控制报价缓存时长 */
export async function getValuation({ quoteMaxAgeMs = 10_000 } = {}) {
  const { state, positions } = await getPortfolio();
  const quotes = positions.length
    ? await getQuotes(positions.map((p) => p.symbol), quoteMaxAgeMs)
    : new Map();

  const enriched = positions.map((p) => {
    const quote = quotes.get(p.symbol);
    const price = quote?.effective_price ?? quote?.price ?? Number(p.avg_cost);
    const marketValue = price * Number(p.quantity);
    const costBasis = Number(p.avg_cost) * Number(p.quantity);
    return {
      ...p,
      quantity: Number(p.quantity),
      avg_cost: Number(p.avg_cost),
      stop_loss: p.stop_loss !== null && p.stop_loss !== undefined ? Number(p.stop_loss) : null,
      take_profit:
        p.take_profit !== null && p.take_profit !== undefined ? Number(p.take_profit) : null,
      current_price: price,
      live_quote: Boolean(quote),
      session: quote?.session ?? null,
      extended_price: quote?.extended_price ?? null,
      extended_change_percent: quote?.extended_change_percent ?? null,
      change_percent: quote?.changesPercentage ?? quote?.changePercentage ?? null,
      market_value: marketValue,
      unrealized_pnl: marketValue - costBasis,
      unrealized_pnl_percent: costBasis > 0 ? ((marketValue - costBasis) / costBasis) * 100 : 0,
    };
  });

  const positionsValue = enriched.reduce((sum, p) => sum + p.market_value, 0);
  const cash = Number(state.cash);
  const initial = Number(state.initial_capital);
  const totalValue = cash + positionsValue;

  return {
    cash,
    initial_capital: initial,
    positions_value: positionsValue,
    total_value: totalValue,
    pnl: totalValue - initial,
    pnl_percent: initial > 0 ? ((totalValue - initial) / initial) * 100 : 0,
    market_session: getMarketSession(),
    positions: enriched,
    // 报价缺失的持仓按成本价计入估值:浮亏被抹平,当日亏损熔断/敞口钳制都会失真,
    // 买入路径据此 fail-closed(missing_quotes 非空时暂缓买入)
    missing_quotes: enriched.filter((p) => !p.live_quote).map((p) => p.symbol),
  };
}

/** 记录一次组合净值快照(用于盈亏折线图) */
export async function takeSnapshot() {
  const valuation = await getValuation();
  const db = supabase();
  const { data, error } = await db
    .from('portfolio_snapshots')
    .insert({
      cash: valuation.cash,
      positions_value: valuation.positions_value,
      total_value: valuation.total_value,
      pnl: valuation.pnl,
      pnl_percent: valuation.pnl_percent,
    })
    .select()
    .single();
  if (error) throw new Error(`写入快照失败: ${error.message}`);
  return data;
}
