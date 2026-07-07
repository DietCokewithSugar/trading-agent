import { supabase } from '../db.js';
import { config } from '../config.js';
import { getQuote, getMarketSession } from './fmp.js';
import { getPortfolio } from './portfolio.js';
import { executeSellOrder } from './trader.js';
import { broadcast } from './bus.js';
import { isHalted } from './halt.js';
import { holdAnchor, isHoldExpired } from './holding.js';
import { computeTrailedStop } from './trailing.js';
import { getTradingStrategy, strategyMaxHoldHours } from './strategy.js';

let running = false;

// opened_at/hold_refreshed_at 列缺失(未执行 020 迁移)时持有时限自动停用,只警告一次
let holdLimitUnavailable = false;

// peak_price 列缺失(未执行 007 迁移)时停用移动止损,只警告一次
let trailingUnavailable = false;

/**
 * 移动止损:棘轮数学在 trailing.js#computeTrailedStop(与 trailing_only 影子变体共用),
 * 本函数只保留开关/降级判断与 DB 写入。返回本次检查应使用的止损价。
 * 注:盘前盘后采用 effective_price,极端情况下稀疏成交可能推高峰值,
 * 模拟盘可接受,换取隔夜跳空前更紧的保护。
 */
async function maybeTrailStop(pos, price) {
  const stop = Number(pos.stop_loss);
  // trailing_only 策略(024)下棘轮强制生效(该策略的定义就是棘轮),否则看全局开关
  const trailingOn = config.enableTrailingStop || getTradingStrategy() === 'trailing_only';
  if (trailingUnavailable || !trailingOn || !(stop > 0)) return stop;

  const trailed = computeTrailedStop({
    price,
    stop,
    peakPrice: pos.peak_price,
    avgCost: pos.avg_cost,
  });
  if (!trailed) return stop;
  const newStop = trailed.stop;

  const { error } = await supabase()
    .from('positions')
    .update({
      peak_price: trailed.peak,
      stop_loss: newStop,
      updated_at: new Date().toISOString(),
    })
    .eq('symbol', pos.symbol);
  if (error) {
    if (/peak_price/.test(error.message)) {
      trailingUnavailable = true;
      console.warn('[risk] peak_price 列不可用,移动止损停用(请执行 007 迁移)');
    } else {
      console.warn(`[risk] ${pos.symbol} 移动止损更新失败: ${error.message}`);
    }
    return stop;
  }
  console.log(`[risk] ${pos.symbol} 移动止损上抬: $${stop} → $${newStop}(峰值 $${price})`);
  return newStop;
}

/**
 * 止损/止盈/持有时限监控:遍历持仓,现价(含盘前盘后)跌破止损价或触及止盈价、
 * 或持有超过 MAX_HOLD_HOURS(同票新利好/买入成交会刷新时钟)时自动全仓卖出。
 * 由调度器定期调用;休市时段价格不变,直接跳过——到期持仓在下一可交易时段
 * (含 04:00 盘前)的首个 tick 平仓。
 */
export async function checkStops() {
  if (running) return;
  if (isHalted()) return;
  if (getMarketSession() === 'closed') return;
  running = true;

  try {
    const { positions } = await getPortfolio();
    for (const pos of positions) {
      let stopLoss = pos.stop_loss !== null && pos.stop_loss !== undefined ? Number(pos.stop_loss) : null;
      const takeProfit =
        pos.take_profit !== null && pos.take_profit !== undefined ? Number(pos.take_profit) : null;

      // 持有时限(020;024 起按策略取值,wide_bracket 96h):锚点缺失说明迁移未执行,
      // 警告一次后自动停用(绝不误平仓)
      const maxHoldHours = strategyMaxHoldHours(getTradingStrategy(), config);
      const anchor = holdAnchor(pos);
      if (maxHoldHours > 0 && anchor === null && !holdLimitUnavailable) {
        holdLimitUnavailable = true;
        console.warn('[risk] positions 缺少 opened_at/hold_refreshed_at 列,持有时限停用(请执行 020 迁移)');
      }
      const expired = isHoldExpired(pos, { maxHoldHours });
      if (!expired && stopLoss === null && takeProfit === null) continue;

      const quote = await getQuote(pos.symbol, 25_000);
      if (!quote) continue;
      const price = quote.effective_price ?? quote.price;

      // 持有超时:与止损/止盈判定无关,未设止损的持仓同样受时限约束
      if (expired) {
        const cost = Number(pos.avg_cost);
        const pnlPercent = (((price - cost) / cost) * 100).toFixed(1);
        const heldHours = Math.round((Date.now() - anchor) / 3600_000);
        const reason = `持有超时强制平仓:已持有约 ${heldHours} 小时(上限 ${maxHoldHours} 小时,${pnlPercent}%)`;
        console.log(`[risk] ${pos.symbol} ${reason}`);
        const trade = await executeSellOrder({
          symbol: pos.symbol,
          price,
          fraction: 1,
          reason,
          trigger: 'max_hold',
        });
        if (trade) broadcast('trade', trade);
        continue;
      }

      // 创新高时先上抬移动止损,再用新止损价做触发判断
      if (stopLoss !== null) {
        stopLoss = await maybeTrailStop(pos, price);
      }
      const cost = Number(pos.avg_cost);
      const pnlPercent = (((price - cost) / cost) * 100).toFixed(1);

      let trigger = null;
      let reason = '';
      if (stopLoss !== null && price <= stopLoss) {
        trigger = 'stop_loss';
        reason = `自动止损:现价 $${price} 跌破止损价 $${stopLoss}(成本 $${cost},${pnlPercent}%)`;
      } else if (takeProfit !== null && price >= takeProfit) {
        trigger = 'take_profit';
        reason = `自动止盈:现价 $${price} 触及止盈价 $${takeProfit}(成本 $${cost},+${pnlPercent}%)`;
      }
      if (!trigger) continue;

      console.log(`[risk] ${pos.symbol} ${reason}`);
      const trade = await executeSellOrder({
        symbol: pos.symbol,
        price,
        fraction: 1,
        reason,
        trigger,
      });
      if (trade) broadcast('trade', trade);
    }
  } catch (err) {
    console.error(`[risk] 止损监控失败: ${err.message}`);
  } finally {
    running = false;
  }
}
