// 券商模拟账户(Alpaca Paper Trading)REST 薄客户端:
// 仅供 brokerMirror.js(对照账本)使用,全部请求原生 fetch + 15s 超时。
// 错误一律抛出由调用方按观测层约定降级(fail-open,绝不影响交易主链路)。
// 文档: https://docs.alpaca.markets/us/docs/trading-api
import { config } from '../config.js';

/** 是否已配置券商模拟账户(key 齐备且未显式关闭) */
export function isBrokerEnabled() {
  return Boolean(config.enableBrokerMirror && config.alpacaKeyId && config.alpacaSecretKey);
}

async function alpacaRequest(method, path, body = null) {
  const res = await fetch(`${config.alpacaBaseUrl}${path}`, {
    method,
    headers: {
      'APCA-API-KEY-ID': config.alpacaKeyId,
      'APCA-API-SECRET-KEY': config.alpacaSecretKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(`券商接口 ${method} ${path} 失败 ${res.status}: ${String(text).slice(0, 200)}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

/**
 * 提交限价单(day 有效)。qty 支持碎股字符串;盘前盘后须 extended_hours=true。
 * client_order_id 为幂等键:重复提交同一 id 时券商返回 422,由调用方按"已提交"处理。
 */
export function submitOrder({ symbol, qty, side, limitPrice, extendedHours = false, clientOrderId }) {
  return alpacaRequest('POST', '/v2/orders', {
    symbol,
    qty: String(qty),
    side,
    type: 'limit',
    time_in_force: 'day',
    limit_price: String(limitPrice),
    extended_hours: extendedHours,
    client_order_id: clientOrderId,
  });
}

/** 按券商订单 id 查询(不存在返回 null) */
export function getOrder(orderId) {
  return alpacaRequest('GET', `/v2/orders/${orderId}`);
}

/** 按幂等键查询订单(重复提交 422 后取回已存在的那单) */
export function getOrderByClientId(clientOrderId) {
  return alpacaRequest('GET', `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`);
}

/** 账户状态(equity/cash/buying_power 等) */
export function getAccount() {
  return alpacaRequest('GET', '/v2/account');
}

/** 单票持仓(无持仓返回 null) */
export function getPosition(symbol) {
  return alpacaRequest('GET', `/v2/positions/${encodeURIComponent(symbol)}`);
}

/** 撤销全部未成交订单(管理重置用) */
export function cancelOpenOrders() {
  return alpacaRequest('DELETE', '/v2/orders');
}

/** 市价清空全部持仓(管理重置用;休市/盘外提交的市价单会排队到下一常规时段) */
export function closeAllPositions() {
  return alpacaRequest('DELETE', '/v2/positions?cancel_orders=true');
}
