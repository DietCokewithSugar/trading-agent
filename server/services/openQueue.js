import { supabase } from '../db.js';
import { config } from '../config.js';
import { getMarketSession } from './fmp.js';
import { executeQueuedBuy, executeSellOrder } from './trader.js';
import { broadcast } from './bus.js';
import { isHalted } from './halt.js';

/**
 * 开盘队列:休市时段产生的交易信号不按 stale 收盘价成交,而是挂入 pending_orders,
 * 待下一个常规交易时段以当日开盘价(叠加盘中滑点)成交。
 * 隔夜新闻的跳空缺口由市场兑现,不再被模拟盘记成策略收益——这是成交真实化的关键一环。
 * pending_orders 表不可用(010 迁移未执行)时整体停用,trader 退回旧的立即成交路径。
 *
 * 014 之后:休市买入的主路径已被候选池(candidate_signals + allocator)替代——
 * 利好信号直接入池等开盘统一分配,本队列主要服务休市卖出与候选池不可用时的 legacy 买入;
 * 历史遗留的买入挂单仍由 fillPendingOrder 照常消化。
 */

let tableMissing = false;

/** 队列运行状态(adminService 重置前 drain 用:在途批次的买入不能与截库并发) */
export const queueStatus = { running: false };

function isMissingTable(error) {
  return (
    error?.code === 'PGRST205' ||
    (/pending_orders/.test(error?.message || '') &&
      /not find|does not exist|schema cache/i.test(error?.message || ''))
  );
}

function warnMissingOnce() {
  if (tableMissing) return;
  tableMissing = true;
  console.warn('[queue] pending_orders 表不可用,开盘队列停用,休市信号退回立即成交(请执行 010 迁移)');
}

/** 休市信号入队。失败返回 null,由调用方退回立即成交,信号不丢 */
export async function enqueuePendingOrder(order) {
  if (tableMissing) return null;
  const { data, error } = await supabase().from('pending_orders').insert(order).select().single();
  if (error) {
    if (isMissingTable(error)) warnMissingOnce();
    else console.warn(`[queue] ${order.symbol} 挂单失败,退回立即成交: ${error.message}`);
    return null;
  }
  console.log(
    `[queue] ${order.symbol} ${order.side === 'buy' ? '买入' : '卖出'}信号挂入开盘队列 #${data.id}(休市,待下一开盘成交)`
  );
  return data;
}

/** 把订单写入终态(filled/cancelled/expired) */
async function closeOrder(order, status, tradeId, note) {
  const { error } = await supabase()
    .from('pending_orders')
    .update({
      status,
      trade_id: tradeId ?? null,
      note: note ? String(note).slice(0, 200) : null,
      processed_at: new Date().toISOString(),
    })
    .eq('id', order.id);
  if (error) console.warn(`[queue] 更新订单 #${order.id} 状态失败: ${error.message}`);
}

async function fillPendingOrder(order) {
  // 超时作废:默认 96 小时,覆盖周末与三天长假;超龄说明服务长期停摆,信号早已过期
  const ageMs = Date.now() - new Date(order.created_at).getTime();
  if (ageMs > config.pendingOrderMaxAgeHours * 3600_000) {
    console.warn(`[queue] 订单 #${order.id} ${order.symbol} 等待超过 ${config.pendingOrderMaxAgeHours} 小时,作废`);
    await closeOrder(order, 'expired', null, `超过最长等待时长 ${config.pendingOrderMaxAgeHours} 小时`);
    return;
  }

  if (order.side === 'buy') {
    const result = await executeQueuedBuy({
      symbol: order.symbol,
      fraction: Number(order.fraction),
      stopLossPercent: order.stop_loss_percent === null ? 8 : Number(order.stop_loss_percent),
      takeProfitPercent: order.take_profit_percent === null ? 15 : Number(order.take_profit_percent),
      reason: order.reason,
      newsId: order.news_id,
      analysisId: order.analysis_id,
    });
    if (result?.trade) {
      await closeOrder(order, 'filled', result.trade.id, '开盘成交');
      broadcast('trade', result.trade);
    } else if (result?.reject && !result.transient) {
      console.log(`[queue] 订单 #${order.id} ${order.symbol} 作废: ${result.reject}`);
      await closeOrder(order, 'cancelled', null, result.reject);
    } else if (result?.reject) {
      // transient 拒绝(人工交易暂停/当日亏损熔断):临时状态,保留挂单下轮/次日重试,
      // 超龄仍由 pendingOrderMaxAgeHours 兜底作废
      console.log(`[queue] 订单 #${order.id} ${order.symbol} 暂缓成交: ${result.reject}`);
    }
    // result 为 null(报价暂不可得):留在队列,下轮重试
    return;
  }

  // 卖出:executeSellOrder 自带最新报价重取与滑点,开盘后的最新价即跳空后价格
  const trade = await executeSellOrder({
    symbol: order.symbol,
    price: Number(order.ref_price),
    fraction: Number(order.fraction),
    reason: order.reason,
    trigger: 'news',
    news_id: order.news_id,
    analysis_id: order.analysis_id,
  });
  if (trade) {
    await closeOrder(order, 'filled', trade.id, '开盘成交');
    broadcast('trade', trade);
  } else {
    // 未持有该股票或卖出金额过小:不可重试,作废
    await closeOrder(order, 'cancelled', null, '未持有该股票或卖出金额过小');
  }
}

/** 由调度器周期调用:常规交易时段把挂起的订单逐一成交 */
export async function processPendingOrders() {
  if (tableMissing || queueStatus.running || isHalted()) return;
  if (getMarketSession() !== 'regular') return;
  queueStatus.running = true;
  try {
    const { data: orders, error } = await supabase()
      .from('pending_orders')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(20);
    if (error) {
      if (isMissingTable(error)) warnMissingOnce();
      else console.warn(`[queue] 读取开盘队列失败: ${error.message}`);
      return;
    }
    for (const order of orders || []) {
      // 逐单复查 halt 旗标:管理重置在批次进行中开始时立即停手,
      // 否则在途买单可能在截库后拿到交易锁,把一笔幽灵交易写进全新账本
      if (isHalted()) {
        console.log('[queue] 检测到全局暂停,本批剩余订单留待下轮');
        return;
      }
      try {
        await fillPendingOrder(order);
      } catch (err) {
        console.warn(`[queue] 订单 #${order.id} ${order.symbol} 成交失败,下轮重试: ${err.message}`);
      }
    }
  } finally {
    queueStatus.running = false;
  }
}

/** 公开接口用:当前等待开盘的挂单列表(表不可用时返回空) */
export async function listPendingOrders(limit = 50) {
  if (tableMissing) return [];
  const { data, error } = await supabase()
    .from('pending_orders')
    .select('id, symbol, side, fraction, ref_price, reason, status, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingTable(error)) warnMissingOnce();
    return [];
  }
  return data || [];
}
