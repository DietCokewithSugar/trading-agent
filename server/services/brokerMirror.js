// 券商模拟对照账本(021):实盘每笔成交镜像到券商模拟账户(marketable 限价单,
// 盘前盘后自动带 extended_hours),轮询回填真实撮合结果,逐笔度量成交价偏差(bps)
// 与账户净值偏离 —— 用真实 NBBO 撮合校准内部滑点模型是偏乐观还是偏悲观。
//
// 观测层三约定(与影子组合一致):
//  - fire-and-forget:镜像经进程内串行队列,任何失败只告警,绝不阻塞交易主链路;
//  - key 缺失整体停用;broker_mirror_* 表缺失(021 未执行)警告一次后停用;
//  - 幂等:client_order_id = trade-{trade_id},券商侧拒绝重复,防止重复镜像。
import { supabase } from '../db.js';
import { config } from '../config.js';
import { getMarketSession } from './fmp.js';
import { getValuation } from './portfolio.js';
import {
  isBrokerEnabled,
  submitOrder,
  getOrder,
  getOrderByClientId,
  getAccount,
  getPosition,
  getPositions,
  cancelOpenOrders,
  closeAllPositions,
} from './alpacaBroker.js';

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── 纯函数(node:test 直接测)──

/** marketable 限价:买 = 内部价 ×(1+slack%),卖 = ×(1−slack%);非法入参返回 null */
export function mirrorLimitPrice({ side, price, slackPercent }) {
  const p = Number(price);
  const s = Number(slackPercent);
  if (!(p > 0) || !Number.isFinite(s) || s < 0) return null;
  const factor = side === 'sell' ? 1 - s / 100 : 1 + s / 100;
  return round2(p * factor);
}

/**
 * 带方向的成交价偏差(bps):买入券商更贵为正、卖出券商更便宜为正 —— 正值 = 对我们不利
 * (即内部账本相对券商真实撮合"记赚了")。
 */
export function signedDiffBps({ side, internalPrice, brokerPrice }) {
  const internal = Number(internalPrice);
  const broker = Number(brokerPrice);
  if (!(internal > 0) || !(broker > 0)) return null;
  const raw = ((broker - internal) / internal) * 10000;
  const signed = side === 'sell' ? -raw : raw;
  return Math.round(signed * 10) / 10;
}

/** 镜像卖出数量:不超过券商持仓;余量 <0.01 股时清干净(防碎股残留);无持仓返回 0 */
export function adjustSellQty({ internalQty, brokerQty }) {
  const want = Number(internalQty);
  const have = Number(brokerQty);
  if (!(have > 0) || !(want > 0)) return 0;
  const qty = Math.min(want, have);
  return have - qty < 0.01 ? have : qty;
}

/**
 * 对照统计(纯函数):orders 为 broker_mirror_orders 行。
 * skipped/error 不计入成交率分母(未真正提交到券商),单独计数。
 */
export function summarizeMirror(orders) {
  const rows = orders || [];
  const submitted = rows.filter((o) => !['skipped', 'error'].includes(o.status));
  const filled = submitted.filter((o) => o.status === 'filled');
  const unfilled = submitted.filter((o) => ['canceled', 'expired', 'rejected'].includes(o.status));
  const pending = submitted.length - filled.length - unfilled.length;
  const diffs = filled
    .map((o) => Number(o.diff_bps))
    .filter((v) => Number.isFinite(v));
  const avg = (list) => (list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 : null);
  const sideStats = (side) => {
    const subset = filled.filter((o) => o.side === side);
    const d = subset.map((o) => Number(o.diff_bps)).filter((v) => Number.isFinite(v));
    return { n: subset.length, avg_bps: avg(d) };
  };
  return {
    orders: submitted.length,
    filled: filled.length,
    fill_rate: submitted.length ? Math.round((filled.length / submitted.length) * 1000) / 10 : null,
    unfilled: unfilled.length,
    pending,
    skipped: rows.filter((o) => o.status === 'skipped').length,
    errors: rows.filter((o) => o.status === 'error').length,
    avg_abs_bps: avg(diffs.map((v) => Math.abs(v))),
    avg_bps: avg(diffs),
    buy: sideStats('buy'),
    sell: sideStats('sell'),
  };
}

/**
 * 纯函数:券商持仓行 → 内部估值持仓形状(展示主账本用,024)。
 * 字段名映射为 getValuation 口径;止损/止盈/盘外字段为 null(券商侧无此概念);
 * 数量/价格非法的行丢弃。载荷不含供应商字段名。
 */
export function mapBrokerPositions(rawPositions) {
  const out = [];
  for (const p of rawPositions || []) {
    const quantity = Number(p?.qty);
    const avgCost = Number(p?.avg_entry_price);
    const price = Number(p?.current_price);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) continue;
    const plpc = Number(p.unrealized_plpc);
    out.push({
      symbol: p.symbol,
      quantity,
      avg_cost: Number.isFinite(avgCost) ? avgCost : null,
      current_price: price,
      market_value: Number.isFinite(Number(p.market_value)) ? Number(p.market_value) : round2(quantity * price),
      unrealized_pnl: Number.isFinite(Number(p.unrealized_pl)) ? Number(p.unrealized_pl) : null,
      unrealized_pnl_percent: Number.isFinite(plpc) ? Math.round(plpc * 100 * 100) / 100 : null,
      stop_loss: null,
      take_profit: null,
      change_percent: null,
      session: null,
      extended_price: null,
      extended_change_percent: null,
    });
  }
  return out;
}

/**
 * 纯函数:券商账户 + 持仓 → getValuation 同形状载荷(前端零改动直接渲染)。
 * 盈亏基线 = 最早一条对照快照的净值(baseline);无基线时盈亏为 null。
 * 带 ledger:'broker' 标记供前端展示「券商模拟账本」标签。
 */
export function buildBrokerValuation({ account, positions, baseline = null, session = null } = {}) {
  const equity = Number(account?.equity);
  const cash = Number(account?.cash);
  const base = Number(baseline);
  const hasBase = Number.isFinite(base) && base > 0;
  return {
    ledger: 'broker',
    cash: Number.isFinite(cash) ? cash : null,
    initial_capital: hasBase ? base : null,
    positions_value: Number.isFinite(equity) && Number.isFinite(cash) ? round2(equity - cash) : null,
    total_value: Number.isFinite(equity) ? equity : null,
    pnl: hasBase && Number.isFinite(equity) ? round2(equity - base) : null,
    pnl_percent: hasBase && Number.isFinite(equity) ? Math.round(((equity - base) / base) * 10000) / 100 : null,
    market_session: session,
    positions: mapBrokerPositions(positions),
    missing_quotes: [],
  };
}

// ── 编排(fail-open)──

let tableMissing = false;
let polling = false;
let lastSnapshotAt = 0;
const SNAPSHOT_INTERVAL_MS = 10 * 60_000;

// 展示主账本(024):账户+持仓短 TTL 缓存(报价推送循环每几秒一轮,护住券商限频);
// 盈亏基线 = 最早一条对照快照净值,取一次后常驻(重置时清除)
const VALUATION_CACHE_MS = 15_000;
let valuationCache = { at: 0, value: null };
let equityBaseline = undefined; // undefined=未取过, null=无快照

async function loadEquityBaseline() {
  if (equityBaseline !== undefined) return equityBaseline;
  try {
    const { data, error } = await supabase()
      .from('broker_mirror_snapshots')
      .select('equity')
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) throw new Error(error.message);
    equityBaseline = data?.length ? Number(data[0].equity) : null;
  } catch {
    equityBaseline = null;
  }
  return equityBaseline;
}

/**
 * 券商模拟账户实时估值(展示主账本,024):账户+全部持仓映射为 getValuation 形状。
 * 15s TTL 缓存;取数失败向上抛,由 primaryLedger 兜底回退内部账本(fail-open)。
 */
export async function getBrokerValuation() {
  if (!isBrokerEnabled()) throw new Error('券商模拟账户未配置');
  if (valuationCache.value && Date.now() - valuationCache.at < VALUATION_CACHE_MS) {
    return valuationCache.value;
  }
  const [account, positions, baseline] = await Promise.all([
    getAccount(),
    getPositions(),
    loadEquityBaseline(),
  ]);
  const value = buildBrokerValuation({
    account,
    positions,
    baseline,
    session: getMarketSession(),
  });
  valuationCache = { at: Date.now(), value };
  return value;
}

/** 最新一条券商净值快照映射为内部快照形状(展示主账本的 snapshot 广播/序列用);无则 null */
export function mapBrokerSnapshotRow(row, baseline = null) {
  if (!row) return null;
  const equity = Number(row.equity);
  const cash = Number(row.cash);
  const base = Number(baseline);
  const hasBase = Number.isFinite(base) && base > 0;
  if (!Number.isFinite(equity)) return null;
  return {
    total_value: equity,
    cash: Number.isFinite(cash) ? cash : null,
    positions_value: Number.isFinite(cash) ? round2(equity - cash) : null,
    pnl: hasBase ? round2(equity - base) : null,
    pnl_percent: hasBase ? Math.round(((equity - base) / base) * 10000) / 100 : null,
    created_at: row.created_at,
  };
}

/** 券商净值时间序列(展示主账本的净值曲线):broker_mirror_snapshots 升序;失败抛错由调用方回退 */
export async function getBrokerSnapshots(sinceIso) {
  const baseline = await loadEquityBaseline();
  let query = supabase()
    .from('broker_mirror_snapshots')
    .select('equity, cash, created_at')
    .order('created_at', { ascending: true })
    .limit(1000);
  if (sinceIso) query = query.gte('created_at', sinceIso);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data || []).map((row) => mapBrokerSnapshotRow(row, baseline)).filter(Boolean);
}

/** 最新券商快照(snapshot SSE 广播用);无数据/失败返回 null */
export async function getLatestBrokerSnapshot() {
  try {
    const baseline = await loadEquityBaseline();
    const { data, error } = await supabase()
      .from('broker_mirror_snapshots')
      .select('equity, cash, created_at')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    return mapBrokerSnapshotRow(data?.[0], baseline);
  } catch {
    return null;
  }
}

// 进程内串行队列:镜像请求逐个执行,避免一轮多笔成交并发打爆券商限频
let chain = Promise.resolve();
function enqueue(label, fn) {
  chain = chain
    .then(fn)
    .catch((err) => console.warn(`[broker] ${label} 失败: ${err.message}`));
}

function isMissingTable(error) {
  return (
    error?.code === 'PGRST205' ||
    (/broker_mirror/.test(error?.message || '') &&
      /not find|does not exist|schema cache/i.test(error?.message || ''))
  );
}

function warnMissingOnce() {
  if (tableMissing) return;
  tableMissing = true;
  console.warn('[broker] broker_mirror_* 表不可用,券商对照账本停用(请执行 021 迁移)');
}

/** 券商订单状态 → 本地状态(未识别的中间态一律按在途处理) */
function mapStatus(brokerStatus) {
  const s = String(brokerStatus || '');
  if (['filled', 'partially_filled', 'canceled', 'expired', 'rejected'].includes(s)) return s;
  return 'submitted';
}

async function insertRow(row) {
  const { error } = await supabase().from('broker_mirror_orders').insert(row);
  if (error) {
    if (isMissingTable(error)) warnMissingOnce();
    // 幂等冲突(唯一键):同一笔 trade 已镜像过,静默忽略
    else if (!/duplicate key|unique/i.test(error.message)) {
      console.warn(`[broker] 对照单落库失败: ${error.message}`);
    }
  }
}

/** 从券商订单对象提取回填字段(含成交则算偏差) */
function fillPatch(order, { side, internalPrice }) {
  const status = mapStatus(order.status);
  const patch = { status, updated_at: new Date().toISOString() };
  if (order.id) patch.broker_order_id = order.id;
  const filledQty = Number(order.filled_qty);
  if (filledQty > 0) patch.filled_qty = filledQty;
  const avgPrice = Number(order.filled_avg_price);
  if (avgPrice > 0) {
    patch.filled_avg_price = avgPrice;
    patch.diff_bps = signedDiffBps({ side, internalPrice, brokerPrice: avgPrice });
  }
  if (order.filled_at) patch.filled_at = order.filled_at;
  return patch;
}

async function doMirror(trade) {
  const symbol = trade.symbol;
  const side = trade.side;
  const internalPrice = Number(trade.price);
  let qty = Number(trade.quantity);
  const clientOrderId = `trade-${trade.id}`;
  const base = {
    trade_id: trade.id,
    symbol,
    side,
    client_order_id: clientOrderId,
    internal_price: internalPrice,
    extended_hours: getMarketSession() !== 'regular',
  };

  // 卖出:以券商侧真实持仓为准(两边账本可能因部分成交/未成交而漂移)
  if (side === 'sell') {
    const pos = await getPosition(symbol).catch(() => undefined);
    if (pos === undefined) throw new Error(`${symbol} 查询券商持仓失败`);
    qty = adjustSellQty({
      internalQty: qty,
      brokerQty: Number(pos?.qty_available ?? pos?.qty ?? 0),
    });
    if (!(qty > 0)) {
      await insertRow({ ...base, qty: 0, status: 'skipped', note: '券商账户无该持仓,跳过镜像卖出' });
      return;
    }
  }

  const limitPrice = mirrorLimitPrice({
    side,
    price: internalPrice,
    slackPercent: config.brokerMirrorLimitSlackPercent,
  });
  const row = { ...base, qty, limit_price: limitPrice };

  const attempt = async (attemptQty) => {
    const order = await submitOrder({
      symbol,
      qty: attemptQty,
      side,
      limitPrice,
      extendedHours: base.extended_hours,
      clientOrderId,
    });
    await insertRow({
      ...row,
      qty: attemptQty,
      status: 'submitted',
      ...fillPatch(order, { side, internalPrice }),
      updated_at: undefined,
    });
    console.log(
      `[broker] 镜像下单 ${side} ${symbol} ×${attemptQty} 限价 $${limitPrice}${base.extended_hours ? '(盘外)' : ''}`
    );
  };

  try {
    await attempt(qty);
  } catch (err) {
    // 幂等冲突:该 trade 已镜像过(重试/并发),取回既有订单回填即可
    if (err.status === 422 && /client_order_id/i.test(JSON.stringify(err.body || ''))) {
      const existing = await getOrderByClientId(clientOrderId).catch(() => null);
      if (existing) return; // 已有记录,轮询循环会继续跟进
    }
    // 碎股被拒(如盘外碎股限制):退整数股重试,不足 1 股记 skipped
    if (err.status === 422 && Number.isFinite(qty) && qty % 1 !== 0) {
      const whole = Math.floor(qty);
      if (whole >= 1) {
        await attempt(whole);
        return;
      }
      await insertRow({ ...row, status: 'skipped', note: `碎股被券商拒绝且不足 1 股: ${err.message}`.slice(0, 200) });
      return;
    }
    await insertRow({ ...row, status: 'error', note: String(err.message).slice(0, 200) });
    throw err;
  }
}

/**
 * 实盘成交镜像入口(trader.js 成交后调用,fire-and-forget):
 * 未配置 key / 表缺失时静默跳过。
 */
export function mirrorTrade(trade) {
  if (!isBrokerEnabled() || tableMissing || !trade?.id || !trade.symbol) return;
  enqueue(`镜像 ${trade.side} ${trade.symbol}`, () => doMirror(trade));
}

/** 由调度器周期调用(60s):回填在途对照单的撮合结果,并限频写净值对照快照 */
export async function pollMirrorOrders() {
  if (!isBrokerEnabled() || tableMissing || polling) return;
  polling = true;
  try {
    const { data: rows, error } = await supabase()
      .from('broker_mirror_orders')
      .select('id, side, internal_price, broker_order_id, client_order_id, status')
      .in('status', ['submitted', 'partially_filled'])
      .order('submitted_at', { ascending: true })
      .limit(50);
    if (error) {
      if (isMissingTable(error)) warnMissingOnce();
      else console.warn(`[broker] 读取在途对照单失败: ${error.message}`);
      return;
    }
    let updated = 0;
    for (const row of rows || []) {
      let order = null;
      try {
        order = row.broker_order_id
          ? await getOrder(row.broker_order_id)
          : await getOrderByClientId(row.client_order_id);
      } catch (err) {
        console.warn(`[broker] 查询对照单 #${row.id} 失败: ${err.message}`);
        continue;
      }
      if (!order) {
        await supabase()
          .from('broker_mirror_orders')
          .update({ status: 'error', note: '券商侧未找到订单', updated_at: new Date().toISOString() })
          .eq('id', row.id);
        continue;
      }
      const patch = fillPatch(order, { side: row.side, internalPrice: row.internal_price });
      if (patch.status !== row.status || patch.filled_avg_price) {
        const { error: updErr } = await supabase().from('broker_mirror_orders').update(patch).eq('id', row.id);
        if (!updErr) updated += 1;
      }
    }

    // 净值对照快照(10 分钟限频):券商账户 equity/cash + 同时刻内部净值
    if (Date.now() - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
      lastSnapshotAt = Date.now();
      try {
        const account = await getAccount();
        const valuation = await getValuation().catch(() => null);
        await supabase().from('broker_mirror_snapshots').insert({
          equity: Number(account.equity),
          cash: Number(account.cash),
          internal_total_value: valuation?.total_value ?? null,
        });
      } catch (err) {
        console.warn(`[broker] 净值对照快照失败: ${err.message}`);
      }
    }
    if (updated) console.log(`[broker] 对照单回填 ${updated} 条`);
  } finally {
    polling = false;
  }
}

/** 公开 API(/api/broker-mirror)数据源:载荷不含供应商名 */
export async function getBrokerMirrorOverview() {
  if (!isBrokerEnabled()) return { enabled: false };
  if (tableMissing) return { enabled: true, available: false };
  try {
    const [snapRes, ordersRes] = await Promise.all([
      supabase()
        .from('broker_mirror_snapshots')
        .select('equity, cash, internal_total_value, created_at')
        .order('created_at', { ascending: false })
        .limit(1),
      supabase()
        .from('broker_mirror_orders')
        .select('id, symbol, side, qty, limit_price, status, filled_avg_price, internal_price, diff_bps, note, submitted_at, filled_at')
        .order('submitted_at', { ascending: false })
        .limit(200),
    ]);
    if (snapRes.error || ordersRes.error) {
      const err = snapRes.error || ordersRes.error;
      if (isMissingTable(err)) {
        warnMissingOnce();
        return { enabled: true, available: false };
      }
      throw new Error(err.message);
    }
    const snap = snapRes.data?.[0] || null;
    const equity = snap ? Number(snap.equity) : null;
    const internal = snap?.internal_total_value !== null && snap?.internal_total_value !== undefined
      ? Number(snap.internal_total_value)
      : null;
    return {
      enabled: true,
      available: true,
      account: snap
        ? {
            equity,
            cash: Number(snap.cash),
            internal_total_value: internal,
            diff_percent:
              equity !== null && internal ? Math.round(((equity - internal) / internal) * 10000) / 100 : null,
            at: snap.created_at,
          }
        : null,
      stats: summarizeMirror(ordersRes.data || []),
      recent: (ordersRes.data || []).slice(0, 20),
    };
  } catch (err) {
    console.warn(`[broker] 对照账本概览失败: ${err.message}`);
    return { enabled: true, available: false };
  }
}

/** 管理重置:撤单+清仓(券商侧)并清空对照表,全部 best-effort;展示主账本缓存/基线一并清除 */
export async function resetBrokerMirror() {
  valuationCache = { at: 0, value: null };
  equityBaseline = undefined;
  if (isBrokerEnabled()) {
    await cancelOpenOrders().catch((err) => console.warn(`[broker] 重置撤单失败: ${err.message}`));
    await closeAllPositions().catch((err) => console.warn(`[broker] 重置清仓失败: ${err.message}`));
  }
  for (const table of ['broker_mirror_orders', 'broker_mirror_snapshots']) {
    const { error } = await supabase().from(table).delete().gte('id', 0);
    if (error && !isMissingTable(error)) {
      console.warn(`[broker] 清空 ${table} 失败: ${error.message}`);
    }
  }
}
