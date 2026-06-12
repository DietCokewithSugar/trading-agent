import { supabase } from '../db.js';
import { config } from '../config.js';
import { reflectTrade } from './deepseek.js';
import { getHoldingBenchmark } from './benchmark.js';

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** trade_reflections 表尚未创建(未执行 006 迁移)时的判定 */
function isMissingTable(error) {
  return (
    error?.code === 'PGRST205' ||
    (/trade_reflections/.test(error?.message || '') &&
      /not find|does not exist|schema cache/i.test(error?.message || ''))
  );
}

let warnedMissingTable = false;
function warnMissingOnce() {
  if (warnedMissingTable) return;
  warnedMissingTable = true;
  console.warn('[memory] trade_reflections 表不可用,交易记忆功能停用(请执行 006 迁移)');
}

// 016 迁移新增的可选列(同期 SPY 基准):旧库缺列时逐列剥离重试,各列只告警一次
const OPTIONAL_REFLECTION_COLUMNS = ['spy_return_percent', 'excess_return_percent'];
const missingReflectionColumns = new Set();

/**
 * 平仓复盘:对一笔已实现盈亏的卖出,回溯买入论点,让 DeepSeek 提炼经验教训并入库。
 * 由 executeSellOrder 在锁外 fire-and-forget 调用,失败绝不影响卖出本身。
 */
export async function reflectOnClosedTrade(sellTrade) {
  if (!config.enableReflection) return null;
  if (!sellTrade || sellTrade.realized_pnl === null || sellTrade.realized_pnl === undefined) {
    return null;
  }
  const db = supabase();

  // 回溯最近一笔买入作为持仓论点(多次加仓时取最后一笔,论点最接近当前持仓语境)
  const { data: buys } = await db
    .from('trades')
    .select('reason, created_at')
    .eq('symbol', sellTrade.symbol)
    .eq('side', 'buy')
    .lt('created_at', sellTrade.created_at)
    .order('created_at', { ascending: false })
    .limit(1);
  const buy = buys?.[0] || null;

  const exitPrice = Number(sellTrade.price);
  const quantity = Number(sellTrade.quantity);
  // 由 realized_pnl 反推平均成本,与成交时的口径完全一致
  const entryPrice =
    quantity > 0 ? round2(exitPrice - Number(sellTrade.realized_pnl) / quantity) : null;
  const pnlPercent =
    entryPrice && entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : null;
  const holdingMinutes = buy
    ? Math.max(
        Math.round(
          (new Date(sellTrade.created_at).getTime() - new Date(buy.created_at).getTime()) / 60_000
        ),
        0
      )
    : null;

  // 同持仓期 SPY 基准(016,fail-open):让模型评判超额收益(alpha)而非绝对盈亏——
  // 大盘普涨日的平庸盈利不算成功,跟随大盘的亏损未必是决策错误
  const benchmark = buy
    ? await getHoldingBenchmark({ entryAt: buy.created_at, exitAt: sellTrade.created_at })
    : null;
  const spyReturnPercent = benchmark?.spyReturnPercent ?? null;
  const excessReturnPercent =
    spyReturnPercent !== null && pnlPercent !== null ? round2(pnlPercent - spyReturnPercent) : null;

  const reflection = await reflectTrade({
    symbol: sellTrade.symbol,
    thesis: buy?.reason || null,
    trigger: sellTrade.trigger,
    entryPrice,
    exitPrice,
    pnlPercent,
    holdingMinutes,
    sellReason: sellTrade.reason || null,
    spyReturnPercent,
    excessReturnPercent,
  });

  const row = {
    trade_id: sellTrade.id,
    symbol: sellTrade.symbol,
    trigger: sellTrade.trigger || null,
    entry_price: entryPrice,
    exit_price: exitPrice,
    realized_pnl: Number(sellTrade.realized_pnl),
    pnl_percent: pnlPercent !== null ? round2(pnlPercent) : null,
    holding_minutes: holdingMinutes,
    thesis: buy?.reason || null,
    outcome_summary: reflection.outcomeSummary,
    lesson: reflection.lesson,
    importance: reflection.importance,
    model: config.deepseekModel,
    spy_return_percent: spyReturnPercent,
    excess_return_percent: excessReturnPercent,
  };
  for (const col of missingReflectionColumns) delete row[col];
  let { data, error } = await db.from('trade_reflections').insert(row).select().single();
  // 016 未迁移:可选基准列逐列剥离重试,复盘照常入库
  while (error && /column|schema/i.test(error.message)) {
    const col = OPTIONAL_REFLECTION_COLUMNS.find((c) => c in row && error.message.includes(c));
    if (!col) break;
    missingReflectionColumns.add(col);
    console.warn(`[memory] trade_reflections 缺少 ${col} 列,已降级不记录(请执行 016 迁移)`);
    delete row[col];
    ({ data, error } = await db.from('trade_reflections').insert(row).select().single());
  }
  if (error) {
    if (isMissingTable(error)) {
      warnMissingOnce();
      return null;
    }
    throw new Error(`复盘入库失败: ${error.message}`);
  }
  console.log(
    `[memory] ${sellTrade.symbol} 平仓复盘: ${reflection.lesson}(importance=${reflection.importance})`
  );
  return data;
}

/**
 * 检索历史教训:该股票最近 perSymbol 条 + 其他股票按 importance 排序的 globalCount 条。
 * 任何失败都返回空数组,绝不阻断交易决策。
 */
export async function getMemories(symbol, { perSymbol = 3, globalCount = 2 } = {}) {
  try {
    const db = supabase();
    const fields = 'symbol, pnl_percent, lesson, importance, created_at';
    const [symRes, globalRes] = await Promise.all([
      db
        .from('trade_reflections')
        .select(fields)
        .eq('symbol', symbol)
        .order('created_at', { ascending: false })
        .limit(perSymbol),
      db
        .from('trade_reflections')
        .select(fields)
        .neq('symbol', symbol)
        .order('importance', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(globalCount),
    ]);
    if (symRes.error || globalRes.error) {
      const err = symRes.error || globalRes.error;
      if (isMissingTable(err)) warnMissingOnce();
      else console.warn(`[memory] 检索历史教训失败: ${err.message}`);
      return [];
    }
    return [...(symRes.data || []), ...(globalRes.data || [])];
  } catch (err) {
    console.warn(`[memory] 检索历史教训失败: ${err.message}`);
    return [];
  }
}
