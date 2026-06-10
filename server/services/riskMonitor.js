import { getQuote, getMarketSession } from './fmp.js';
import { getPortfolio } from './portfolio.js';
import { executeSellOrder } from './trader.js';
import { broadcast } from './bus.js';

let running = false;

/**
 * 止损/止盈监控:遍历持仓,现价(含盘前盘后)跌破止损价或触及止盈价时自动全仓卖出。
 * 由调度器定期调用;休市时段价格不变,直接跳过。
 */
export async function checkStops() {
  if (running) return;
  if (getMarketSession() === 'closed') return;
  running = true;

  try {
    const { positions } = await getPortfolio();
    for (const pos of positions) {
      const stopLoss = pos.stop_loss !== null && pos.stop_loss !== undefined ? Number(pos.stop_loss) : null;
      const takeProfit =
        pos.take_profit !== null && pos.take_profit !== undefined ? Number(pos.take_profit) : null;
      if (stopLoss === null && takeProfit === null) continue;

      const quote = await getQuote(pos.symbol, 25_000);
      if (!quote) continue;
      const price = quote.effective_price ?? quote.price;
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
