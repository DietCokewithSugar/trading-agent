// 券商模拟账户(Alpaca Paper Trading)REST 薄客户端:
// 供 brokerMirror.js(实盘对照账本,021)与 brokerAccounts.js(多账户消融执行,025)使用,
// 全部请求原生 fetch + 15s 超时。错误一律抛出由调用方按观测层约定降级
// (fail-open,绝不影响交易主链路)。
// 文档: https://docs.alpaca.markets/us/docs/trading-api
import { config } from '../config.js';

/** 是否已配置券商模拟账户(key 齐备且未显式关闭) */
export function isBrokerEnabled() {
  return Boolean(config.enableBrokerMirror && config.alpacaKeyId && config.alpacaSecretKey);
}

/**
 * 按指定凭据构建客户端(025 多账户用):每个管理员添加的券商模拟账户各持一套 key,
 * baseUrl 缺省时用服务端默认端点。返回与模块级导出同名的一组方法。
 */
export function makeBrokerClient({ keyId, secretKey, baseUrl = null } = {}) {
  const root = baseUrl || config.alpacaBaseUrl;

  async function request(method, path, body = null) {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: {
        'APCA-API-KEY-ID': keyId,
        'APCA-API-SECRET-KEY': secretKey,
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

  return {
    /**
     * 提交限价单(day 有效)。qty 支持碎股字符串;盘前盘后须 extended_hours=true。
     * client_order_id 为幂等键:重复提交同一 id 时券商返回 422,由调用方按"已提交"处理。
     */
    submitOrder({ symbol, qty, side, limitPrice, extendedHours = false, clientOrderId }) {
      return request('POST', '/v2/orders', {
        symbol,
        qty: String(qty),
        side,
        type: 'limit',
        time_in_force: 'day',
        limit_price: String(limitPrice),
        extended_hours: extendedHours,
        client_order_id: clientOrderId,
      });
    },
    /** 按券商订单 id 查询(不存在返回 null) */
    getOrder(orderId) {
      return request('GET', `/v2/orders/${orderId}`);
    },
    /** 按幂等键查询订单(重复提交 422 后取回已存在的那单) */
    getOrderByClientId(clientOrderId) {
      return request('GET', `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`);
    },
    /** 账户状态(equity/cash/buying_power 等) */
    getAccount() {
      return request('GET', '/v2/account');
    },
    /** 单票持仓(无持仓返回 null) */
    getPosition(symbol) {
      return request('GET', `/v2/positions/${encodeURIComponent(symbol)}`);
    },
    /** 全部持仓(空仓返回 []) */
    getPositions() {
      return request('GET', '/v2/positions');
    },
    /** 撤销全部未成交订单(管理重置用) */
    cancelOpenOrders() {
      return request('DELETE', '/v2/orders');
    },
    /** 市价清空全部持仓(管理重置用;休市/盘外提交的市价单会排队到下一常规时段) */
    closeAllPositions() {
      return request('DELETE', '/v2/positions?cancel_orders=true');
    },
  };
}

// ── 默认客户端(021 实盘对照账本,凭据来自环境变量)──
// 惰性构建:环境变量在进程启动时即固定,构建一次即可
let defaultClient = null;
function client() {
  if (!defaultClient) {
    defaultClient = makeBrokerClient({
      keyId: config.alpacaKeyId,
      secretKey: config.alpacaSecretKey,
    });
  }
  return defaultClient;
}

export function submitOrder(params) {
  return client().submitOrder(params);
}

export function getOrder(orderId) {
  return client().getOrder(orderId);
}

export function getOrderByClientId(clientOrderId) {
  return client().getOrderByClientId(clientOrderId);
}

export function getAccount() {
  return client().getAccount();
}

export function getPosition(symbol) {
  return client().getPosition(symbol);
}

export function getPositions() {
  return client().getPositions();
}

export function cancelOpenOrders() {
  return client().cancelOpenOrders();
}

export function closeAllPositions() {
  return client().closeAllPositions();
}
