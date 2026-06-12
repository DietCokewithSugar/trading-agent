import { supabase } from '../db.js';
import { config } from '../config.js';
import { getValuation } from './portfolio.js';
import { reviewPositions } from './deepseek.js';
import { executeSellOrder } from './trader.js';
import { getMarketSession, getQuote, getHistoricalPricesAdjusted } from './fmp.js';
import { etDateOf, spyHoldingReturn } from './benchmark.js';
import { broadcast } from './bus.js';
import { isHalted } from './halt.js';

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const ET_HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  hourCycle: 'h23',
});

let lastReviewedEtDate = null;
let running = false;

/**
 * 持仓股最近的新闻分析(每只最多 2 条),作为"论点是否过时"的判断输入。
 * 逐票限量查询:全局按时间排序的单查询会让新闻活跃的一只票吃掉全部配额,
 * 其余持仓拿到空上下文(持仓数受 MAX_OPEN_POSITIONS 约束,并发量可控)
 */
async function getRecentAnalyses(symbols) {
  const map = new Map();
  await Promise.all(
    symbols.map(async (symbol) => {
      const { data, error } = await supabase()
        .from('news_analyses')
        .select('symbol, sentiment, tier, event_summary, reasoning, created_at')
        .eq('symbol', symbol)
        .order('created_at', { ascending: false })
        .limit(2);
      if (error) {
        console.warn(`[review] 读取 ${symbol} 相关分析失败: ${error.message}`);
        return;
      }
      if (data?.length) map.set(symbol, data);
    })
  );
  return map;
}

/**
 * 收紧止损:只升不降,且不超过现价。
 * 同时把 peak_price 重锚到现价(只升不降):收紧后的止损可能高于陈旧峰值,
 * 否则移动止损会因"距离 ≤ 0"从此静默失效;列缺失(007 未迁移)时降级只写止损
 */
async function tightenStop(position, newStopLossPercent, price, reason) {
  const newStop = round4(price * (1 - newStopLossPercent / 100));
  const current = position.stop_loss !== null ? Number(position.stop_loss) : null;
  if (current !== null && newStop <= current) {
    console.log(`[review] ${position.symbol} 建议止损 $${newStop} 不高于现值 $${current},忽略`);
    return;
  }
  const prevPeak = position.peak_price !== null && position.peak_price !== undefined ? Number(position.peak_price) : null;
  const update = {
    stop_loss: newStop,
    updated_at: new Date().toISOString(),
    ...(prevPeak === null || price > prevPeak ? { peak_price: round4(price) } : {}),
  };
  let { error } = await supabase().from('positions').update(update).eq('symbol', position.symbol);
  if (error && /peak_price/.test(error.message)) {
    const { peak_price, ...legacy } = update;
    ({ error } = await supabase().from('positions').update(legacy).eq('symbol', position.symbol));
  }
  if (error) {
    console.warn(`[review] ${position.symbol} 收紧止损失败: ${error.message}`);
    return;
  }
  console.log(`[review] ${position.symbol} 收紧止损: $${current ?? '—'} → $${newStop}(${reason})`);
}

/**
 * 每日持仓复查:每个交易日 positionReviewHour(美东)后执行一次,
 * 用一次 DeepSeek 调用评估全部持仓——论点是否失效、是否主动止损/收紧止损。
 * 由调度器每 10 分钟探测触发条件;失败不记当日,下个探测点重试。
 */
export async function maybeRunDailyReview() {
  if (!config.enablePositionReview || running || isHalted()) return;
  if (getMarketSession() !== 'regular') return;

  const now = new Date();
  const today = ET_DATE_FMT.format(now);
  const etHour = Number(ET_HOUR_FMT.format(now));
  if (etHour < config.positionReviewHour || lastReviewedEtDate === today) return;

  running = true;
  try {
    const valuation = await getValuation();
    if (!valuation.positions.length) {
      lastReviewedEtDate = today;
      return;
    }

    const symbols = valuation.positions.map((p) => p.symbol);
    const analysesBySymbol = await getRecentAnalyses(symbols);

    // 持仓期 SPY 基准(016,fail-open):一次取数覆盖全部持仓,
    // 让模型相对大盘评判表现——大盘红利不是论点质量。失败省略字段,复查照常
    let spyRows = null;
    let spyDayChange = null;
    try {
      const openedDates = valuation.positions.map((p) => etDateOf(p.opened_at)).filter(Boolean);
      if (openedDates.length) {
        const earliest = [...openedDates].sort()[0];
        const from = new Date(`${earliest}T00:00:00Z`);
        from.setUTCDate(from.getUTCDate() - 7);
        ({ rows: spyRows } = await getHistoricalPricesAdjusted(
          'SPY',
          from.toISOString().slice(0, 10),
          today
        ));
      }
      const q = await getQuote('SPY');
      const chg = Number(q?.changesPercentage ?? q?.changePercentage);
      spyDayChange = Number.isFinite(chg) ? Math.round(chg * 100) / 100 : null;
    } catch (err) {
      console.warn(`[review] SPY 基准获取失败(按绝对盈亏退化复查): ${err.message}`);
    }

    const positionsCtx = valuation.positions.map((p) => {
      const openedDate = etDateOf(p.opened_at);
      // 当日建仓:日线无跨度,用 SPY 当日涨跌近似;跨日:收盘对收盘
      const spyRet =
        openedDate === today
          ? spyDayChange
          : spyHoldingReturn({ rows: spyRows || [], entryEtDate: openedDate, exitEtDate: today });
      return {
        代码: p.symbol,
        数量: p.quantity,
        平均成本: p.avg_cost,
        现价: p.current_price,
        浮动盈亏百分比: Math.round(p.unrealized_pnl_percent * 100) / 100,
        止损价: p.stop_loss,
        止盈价: p.take_profit,
        建仓时间: p.opened_at,
        ...(spyRet !== null && spyRet !== undefined ? { 同期SPY涨跌百分比: spyRet } : {}),
        近期相关分析: (analysesBySymbol.get(p.symbol) || []).map((a) => ({
          方向: a.sentiment,
          档位: a.tier,
          事件: a.event_summary || a.reasoning,
          时间: a.created_at,
        })),
      };
    });

    console.log(`[review] 开始每日持仓复查(${symbols.length} 只持仓)`);
    const reviews = await reviewPositions({
      positions: positionsCtx,
      cash: valuation.cash,
      totalValue: valuation.total_value,
    });

    for (const review of reviews) {
      // 防御:模型可能编造不存在的持仓代码
      const position = valuation.positions.find((p) => p.symbol === review.symbol);
      if (!position) continue;

      if (review.action === 'sell' && review.fraction > 0) {
        const trade = await executeSellOrder({
          symbol: review.symbol,
          price: position.current_price,
          fraction: review.fraction,
          reason: `持仓复查:${review.reason}`,
          trigger: 'review',
        });
        if (trade) broadcast('trade', trade);
      } else if (review.action === 'tighten_stop') {
        await tightenStop(position, review.newStopLossPercent, position.current_price, review.reason);
      } else if (review.reason) {
        console.log(`[review] ${review.symbol} 维持持有: ${review.reason}`);
      }
    }

    lastReviewedEtDate = today;
    console.log('[review] 每日持仓复查完成');
  } catch (err) {
    console.error(`[review] 持仓复查失败: ${err.message}`);
  } finally {
    running = false;
  }
}
