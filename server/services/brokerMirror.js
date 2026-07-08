// 券商模拟对照账本(021):实盘每笔成交镜像到券商模拟账户(marketable 限价单,
// 盘前盘后自动带 extended_hours),轮询回填真实撮合结果,逐笔度量成交价偏差(bps)
// 与账户净值偏离 —— 用真实 NBBO 撮合校准内部滑点模型是偏乐观还是偏悲观。
//
// 027 起镜像单未成交不再一弃了之(否则卖单过期在券商账户滞留孤儿持仓、买单过期永不建仓,
// 两账本永久分歧):休市顺延(status='deferred',开盘后以实时价挂单,不再用过期报价挂必死单)、
// 到期按 mirrorPolicy.js 重挂(卖单限价重试耗尽升级市价单保证收敛;买单限时追单,漂移超限放弃)、
// 定期对账清理滞留持仓(仅实盘镜像账户;影子变体账户需对比各变体虚拟持仓,留作后续)。
//
// 观测层三约定(与影子组合一致):
//  - fire-and-forget:镜像经进程内串行队列,任何失败只告警,绝不阻塞交易主链路;
//  - key 缺失整体停用;broker_mirror_* 表缺失(021 未执行)警告一次后停用;
//  - 幂等:client_order_id = trade-{trade_id}(重挂子行加 -rN 后缀、对账单 reconcile-{SYM}-{日期}),
//    券商侧拒绝重复,防止重复镜像。
import { supabase } from '../db.js';
import { config } from '../config.js';
import { getMarketSession, getQuote } from './fmp.js';
import { getValuation, getPortfolio } from './portfolio.js';
import { etDayKey } from './metrics.js';
import {
  mirrorLimitPrice,
  remainingQty,
  nextRetryClientOrderId,
  planMirrorFollowUp,
  planReconcile,
} from './mirrorPolicy.js';
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
import { accountsForPurpose, enabledAccounts, accountById, credsOf } from './brokerAccounts.js';

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── 纯函数(node:test 直接测;限价/重挂决策类纯函数在 mirrorPolicy.js)──

export { mirrorLimitPrice };

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
 * skipped/error 不计入成交率分母(未真正提交到券商),单独计数;
 * 被重挂接替的未成交终态行(id 被别行 retry_of 引用,027)记 retried 并出分母 ——
 * 成交率保持"内部成交最终镜像成功率"语义,重挂过程不摊薄它;
 * deferred(休市顺延)按在途计,abandoned(追单放弃)计入未成交。
 */
export function summarizeMirror(orders) {
  const rows = orders || [];
  const UNFILLED = ['canceled', 'expired', 'rejected', 'abandoned'];
  const retriedIds = new Set(rows.map((o) => o.retry_of).filter((v) => v !== null && v !== undefined));
  const superseded = (o) => UNFILLED.includes(o.status) && retriedIds.has(o.id);
  const submitted = rows.filter((o) => !['skipped', 'error'].includes(o.status) && !superseded(o));
  const filled = submitted.filter((o) => o.status === 'filled');
  const unfilled = submitted.filter((o) => UNFILLED.includes(o.status));
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
    retried: rows.filter(superseded).length,
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
// 快照节奏(BROKER_SNAPSHOT_SECONDS,默认 30s、下限 10s):休市时段净值不动,自动降回 10 分钟
function snapshotIntervalMs() {
  const base = Math.max(config.brokerSnapshotSeconds, 10) * 1000;
  return getMarketSession() === 'closed' ? Math.max(base, 10 * 60_000) : base;
}

// 展示主账本(024):账户+持仓短 TTL 缓存(报价推送循环每几秒一轮,护住券商限频);
// 盈亏基线 = 最早一条对照快照净值,取一次后常驻(重置时清除)
const VALUATION_CACHE_MS = 15_000;
let valuationCache = { at: 0, value: null };
let equityBaseline = undefined; // undefined=未取过, null=无快照

// env 默认账户的快照过滤(025 多账户后 account_id=null 才是默认账户;缺列=纯旧库,不过滤)
async function envSnapshotQuery(columns, ascending, limit) {
  let query = supabase()
    .from('broker_mirror_snapshots')
    .select(columns)
    .is('account_id', null)
    .order('created_at', { ascending })
    .limit(limit);
  let { data, error } = await query;
  if (error && /account_id/.test(error.message)) {
    ({ data, error } = await supabase()
      .from('broker_mirror_snapshots')
      .select(columns)
      .order('created_at', { ascending })
      .limit(limit));
  }
  return { data, error };
}

async function loadEquityBaseline() {
  if (equityBaseline !== undefined) return equityBaseline;
  try {
    const { data, error } = await envSnapshotQuery('equity', true, 1);
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

/**
 * 全部券商模拟账户的实时账户+持仓(管理页「实时仓位」用,token 门内):
 * env 默认账户 + 每个启用的附加账户(025)并发取数,单账户失败只标注 error 不影响其余。
 * 持仓经 mapBrokerPositions 映射为内部口径;无任何账户时返回空列表。
 */
export async function listBrokerAccountsLive() {
  const targets = [];
  if (isBrokerEnabled()) {
    targets.push({ id: null, label: '默认账户(环境变量)', purpose: 'mirror_actual', creds: null });
  }
  for (const acc of enabledAccounts()) {
    targets.push({ id: acc.id, label: acc.label, purpose: acc.purpose, creds: credsOf(acc) });
  }
  const accounts = await Promise.all(
    targets.map(async (t) => {
      const base = { id: t.id, label: t.label, purpose: t.purpose };
      try {
        const [account, positions] = await Promise.all([getAccount(t.creds), getPositions(t.creds)]);
        const equity = Number(account.equity);
        const cash = Number(account.cash);
        return {
          ...base,
          equity: Number.isFinite(equity) ? equity : null,
          cash: Number.isFinite(cash) ? cash : null,
          positions_value: Number.isFinite(equity) && Number.isFinite(cash) ? round2(equity - cash) : null,
          positions: mapBrokerPositions(positions),
        };
      } catch (err) {
        return { ...base, error: err.message, positions: [] };
      }
    })
  );
  return { accounts, market_session: getMarketSession() };
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

/** 券商净值时间序列(展示主账本的净值曲线,env 默认账户):升序;失败抛错由调用方回退 */
export async function getBrokerSnapshots(sinceIso) {
  const baseline = await loadEquityBaseline();
  let query = supabase()
    .from('broker_mirror_snapshots')
    .select('equity, cash, created_at')
    .is('account_id', null)
    .order('created_at', { ascending: true })
    .limit(5000);
  if (sinceIso) query = query.gte('created_at', sinceIso);
  let { data, error } = await query;
  if (error && /account_id/.test(error.message)) {
    let fallback = supabase()
      .from('broker_mirror_snapshots')
      .select('equity, cash, created_at')
      .order('created_at', { ascending: true })
      .limit(5000);
    if (sinceIso) fallback = fallback.gte('created_at', sinceIso);
    ({ data, error } = await fallback);
  }
  if (error) throw new Error(error.message);
  // 30s 快照粒度下行数远超图表可用点数:均匀降采样到 ≤600 点(保首尾)
  let rows = data || [];
  if (rows.length > 600) {
    const step = (rows.length - 1) / 599;
    rows = Array.from({ length: 600 }, (_, i) => rows[Math.round(i * step)]);
  }
  return rows.map((row) => mapBrokerSnapshotRow(row, baseline)).filter(Boolean);
}

/** 最新券商快照(snapshot SSE 广播用,env 默认账户);无数据/失败返回 null */
export async function getLatestBrokerSnapshot() {
  try {
    const baseline = await loadEquityBaseline();
    const { data, error } = await envSnapshotQuery('equity, cash, created_at', false, 1);
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

// 027 列(attempt/retry_of)缺失:重挂机制降级停用(顺延/对账仍工作),警告一次
let retryColumnsMissing = false;
function warnRetryColumnsOnce() {
  if (retryColumnsMissing) return;
  retryColumnsMissing = true;
  console.warn('[broker] broker_mirror_orders 缺 attempt/retry_of 列,镜像重挂降级停用(请执行 027 迁移)');
}

async function insertRow(row) {
  let payload = row;
  let { error } = await supabase().from('broker_mirror_orders').insert(payload);
  // 027 未迁移:剥掉重挂记账列重试(第二道防线,主防线是轮询侧的 retryColumnsMissing 旗标)
  if (error && /attempt|retry_of/.test(error.message) && ('attempt' in payload || 'retry_of' in payload)) {
    warnRetryColumnsOnce();
    const { attempt, retry_of, ...rest } = payload;
    payload = rest;
    ({ error } = await supabase().from('broker_mirror_orders').insert(payload));
  }
  if (error) {
    if (isMissingTable(error)) warnMissingOnce();
    // 幂等冲突(唯一键):同一笔 trade/尝试已镜像过,静默忽略
    else if (!/duplicate key|unique/i.test(error.message)) {
      console.warn(`[broker] 对照单落库失败: ${error.message}`);
    }
  }
}

async function patchRow(id, patch) {
  const { error } = await supabase()
    .from('broker_mirror_orders')
    .update({ updated_at: new Date().toISOString(), ...patch })
    .eq('id', id);
  if (error) {
    if (isMissingTable(error)) warnMissingOnce();
    else console.warn(`[broker] 对照单 #${id} 更新失败: ${error.message}`);
    return false;
  }
  return true;
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

/** 重挂/追单策略参数(mirrorPolicy.js 入参) */
function policyConfig() {
  return {
    slackPercent: config.brokerMirrorLimitSlackPercent,
    maxRetries: config.brokerMirrorMaxRetries,
    buyRetry: config.brokerMirrorBuyRetry,
    // 买单追价漂移上限复用内部账本的漂移放弃线(BUY_PRICE_DRIFT_ABORT_PERCENT)
    buyDriftCapPercent: config.buyPriceDriftAbortPercent,
  };
}

/**
 * 共享提交助手(首挂/顺延提交/重挂/对账共用):提交券商订单并落库
 * (existingRowId 为空插新行,否则 in-place 更新该 deferred 行)。
 * 幂等:422 重复 client_order_id → 取回既有订单按其状态落库(崩溃重放安全);
 * 碎股 422 → 退整数股,不足 1 股记 skipped;其余参数级 422 → 落 error 终态防死循环。
 * 网络/5xx 瞬态失败不落新行(errorRowOnFail 的首挂路径除外),调用方下轮重放。
 * 返回 { ok, permanent?, error? }。
 */
async function submitAndRecord({
  base,
  qty,
  limitPrice = null,
  orderType = 'limit',
  extendedHours = false,
  creds = null,
  existingRowId = null,
  errorRowOnFail = false,
  logLabel = '镜像下单',
}) {
  const { symbol, side, client_order_id: clientOrderId, internal_price: internalPrice } = base;

  const persist = async (order, attemptQty) => {
    const fill = fillPatch(order, { side, internalPrice });
    if (existingRowId) {
      await patchRow(existingRowId, {
        qty: attemptQty,
        limit_price: limitPrice,
        extended_hours: extendedHours,
        status: 'submitted',
        note: null,
        submitted_at: new Date().toISOString(),
        ...fill,
      });
    } else {
      await insertRow({
        ...base,
        qty: attemptQty,
        limit_price: limitPrice,
        extended_hours: extendedHours,
        status: 'submitted',
        ...fill,
        updated_at: undefined,
      });
    }
    console.log(
      `[broker] ${logLabel} ${side} ${symbol} ×${attemptQty}${orderType === 'market' ? ' 市价' : ` 限价 $${limitPrice}`}${extendedHours ? '(盘外)' : ''}`
    );
  };

  const recordTerminal = async (status, note) => {
    if (existingRowId) await patchRow(existingRowId, { status, note });
    else await insertRow({ ...base, qty, limit_price: limitPrice, extended_hours: extendedHours, status, note });
  };

  const trySubmit = (attemptQty) =>
    submitOrder({ symbol, qty: attemptQty, side, type: orderType, limitPrice, extendedHours, clientOrderId }, creds);

  try {
    const order = await trySubmit(qty);
    await persist(order, qty);
    return { ok: true };
  } catch (err) {
    // 幂等冲突:该 client_order_id 已提交过(重试/崩溃重放),取回既有订单落库
    if (err.status === 422 && /client_order_id/i.test(JSON.stringify(err.body || ''))) {
      const existing = await getOrderByClientId(clientOrderId, creds).catch(() => null);
      if (existing) {
        await persist(existing, qty);
        return { ok: true };
      }
    }
    // 碎股被拒(如盘外碎股限制):退整数股重试,不足 1 股记 skipped
    if (err.status === 422 && Number.isFinite(Number(qty)) && Number(qty) % 1 !== 0) {
      const whole = Math.floor(Number(qty));
      if (whole >= 1) {
        try {
          const order = await trySubmit(whole);
          await persist(order, whole);
          return { ok: true };
        } catch (err2) {
          await recordTerminal('error', String(err2.message).slice(0, 200));
          return { ok: false, permanent: true, error: err2 };
        }
      }
      await recordTerminal('skipped', `碎股被券商拒绝且不足 1 股: ${err.message}`.slice(0, 200));
      return { ok: true };
    }
    if (err.status === 422) {
      // 参数级拒绝(标的不可交易等):落 error 终态,防止无限重试
      await recordTerminal('error', String(err.message).slice(0, 200));
      return { ok: false, permanent: true, error: err };
    }
    // 网络/5xx 瞬态:顺延/重挂路径不落行(下轮重放);首挂路径保留旧行为落 error 行
    if (errorRowOnFail) await recordTerminal('error', String(err.message).slice(0, 200));
    return { ok: false, permanent: false, error: err };
  }
}

/**
 * 镜像下单核心(025 起多账户):account=null 为 env 默认账户;
 * sourceVariant 非空表示镜像的是该影子变体的买卖(trade 为影子成交行)。
 * 幂等键按账户隔离(trade-{id} / shadow-{id} + -a{accountId} 后缀)。
 * 休市时段不直接提交(当日限价单必然过期,且限价基于过期报价):落 deferred 行,
 * 开盘后由轮询以实时价挂单;卖出定量同样推迟到提交时。
 */
async function doMirror(trade, account = null, sourceVariant = null) {
  const creds = credsOf(account);
  const symbol = trade.symbol;
  const side = trade.side;
  const internalPrice = Number(trade.price);
  let qty = Number(trade.quantity);
  const clientOrderId = `${sourceVariant ? 'shadow' : 'trade'}-${trade.id}${account ? `-a${account.id}` : ''}`;
  const base = {
    trade_id: sourceVariant ? null : trade.id,
    symbol,
    side,
    client_order_id: clientOrderId,
    internal_price: internalPrice,
    ...(account ? { account_id: account.id } : {}),
    ...(sourceVariant ? { source_variant: sourceVariant } : {}),
  };
  const session = getMarketSession();
  const label = `镜像下单${account ? `(账户 ${account.label})` : ''}${sourceVariant ? `[${sourceVariant}]` : ''}`;

  if (session === 'closed') {
    await insertRow({ ...base, qty, limit_price: null, status: 'deferred', note: '休市顺延,待可交易时段以实时价挂单' });
    console.log(`[broker] ${label} ${side} ${symbol} ×${qty} 休市顺延`);
    return;
  }

  // 卖出:以该券商账户的真实持仓为准(两边账本可能因部分成交/未成交而漂移)
  if (side === 'sell') {
    const pos = await getPosition(symbol, creds).catch(() => undefined);
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

  const res = await submitAndRecord({
    base,
    qty,
    limitPrice: mirrorLimitPrice({ side, price: internalPrice, slackPercent: config.brokerMirrorLimitSlackPercent }),
    extendedHours: session !== 'regular',
    creds,
    errorRowOnFail: true,
    logLabel: label,
  });
  if (!res.ok) throw res.error;
}

/**
 * 实盘成交镜像入口(trader.js 成交后调用,fire-and-forget):
 * env 默认账户 + 全部用途为 mirror_actual 的启用账户各镜像一单。
 */
export function mirrorTrade(trade) {
  if (tableMissing || !trade?.id || !trade.symbol) return;
  if (isBrokerEnabled()) {
    enqueue(`镜像 ${trade.side} ${trade.symbol}`, () => doMirror(trade));
  }
  for (const account of accountsForPurpose('mirror_actual')) {
    enqueue(`镜像 ${trade.side} ${trade.symbol} → ${account.label}`, () => doMirror(trade, account));
  }
}

/**
 * 影子成交镜像入口(025,shadowPortfolio 落库后调用,fire-and-forget):
 * 用途绑定为该变体的账户各镜像一单——消融实验的买卖在真实盘口(NBBO)撮合。
 * trade 为影子成交行 { id, symbol, side, quantity, price }。
 */
export function mirrorShadowTrade(variant, trade) {
  if (tableMissing || !trade?.id || !trade.symbol) return;
  for (const account of accountsForPurpose(variant)) {
    enqueue(`影子镜像[${variant}] ${trade.side} ${trade.symbol} → ${account.label}`, () =>
      doMirror(trade, account, variant)
    );
  }
}

/**
 * 净值对照快照(限频在内,双入口安全):env 默认账户 + 各附加账户逐个落快照。
 * 由独立调度循环(BROKER_SNAPSHOT_SECONDS)与对照轮询共同驱动,先到先写。
 */
export async function takeBrokerSnapshots() {
  if (tableMissing) return;
  if (Date.now() - lastSnapshotAt < snapshotIntervalMs()) return;
  lastSnapshotAt = Date.now();
  if (isBrokerEnabled()) {
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
  for (const acc of enabledAccounts()) {
    try {
      const account = await getAccount(credsOf(acc));
      await supabase().from('broker_mirror_snapshots').insert({
        equity: Number(account.equity),
        cash: Number(account.cash),
        internal_total_value: null,
        account_id: acc.id,
      });
    } catch (err) {
      console.warn(`[broker] 账户 ${acc.label} 净值快照失败: ${err.message}`);
    }
  }
}

/** 取实时报价(盘外用 effective_price);失败返回 null,决策侧按 wait 处理(fail-open) */
async function fetchLivePrice(symbol, context) {
  try {
    const quote = await getQuote(symbol);
    const price = Number(quote?.effective_price ?? quote?.price);
    return price > 0 ? price : null;
  } catch (err) {
    console.warn(`[broker] ${context} ${symbol} 取报价失败: ${err.message}`);
    return null;
  }
}

/** 顺延单(deferred)提交:开盘后以实时价挂单;返回是否写了行(计入回填数) */
async function submitDeferredRow(row, creds) {
  const session = getMarketSession();
  if (session === 'closed') return false;
  const price = await fetchLivePrice(row.symbol, `顺延单 #${row.id}`);
  const plan = planMirrorFollowUp({ row, session, currentPrice: price, config: policyConfig() });
  if (plan.action === 'wait') return false;
  if (plan.action === 'abandon') {
    return patchRow(row.id, { status: 'abandoned', note: plan.note });
  }
  // submit_deferred:卖出数量按券商当前持仓重定
  let qty = Number(row.qty);
  if (row.side === 'sell') {
    const pos = await getPosition(row.symbol, creds).catch(() => undefined);
    if (pos === undefined) return false; // 查持仓失败,下轮重试
    qty = adjustSellQty({ internalQty: qty, brokerQty: Number(pos?.qty_available ?? pos?.qty ?? 0) });
    if (!(qty > 0)) {
      return patchRow(row.id, { status: 'skipped', note: '开盘时券商已无持仓,跳过顺延卖出' });
    }
  }
  const res = await submitAndRecord({
    base: row,
    qty,
    limitPrice: plan.limitPrice,
    extendedHours: plan.extendedHours,
    creds,
    existingRowId: row.id,
    logLabel: '顺延单提交',
  });
  return res.ok;
}

/**
 * 在途单迁移到未成交终态时的跟进(027):按 mirrorPolicy 决策重挂/升级/放弃。
 * 返回 { proceed, note? }:proceed=false 表示瞬态障碍(报价/持仓查询失败、瞬态提交失败),
 * 调用方本轮不写终态 patch,下轮重放整个迁移;note 追加进父行终态 patch。
 * 顺序:先提交/落子行,最后才写父行终态 —— 崩溃在任何一步都能靠幂等键安全重放。
 */
async function handleTerminalTransition(row, patch, creds) {
  const session = getMarketSession();
  const effectiveRow = { ...row, filled_qty: patch.filled_qty ?? row.filled_qty };
  const price = await fetchLivePrice(row.symbol, `对照单 #${row.id}`);
  const plan = planMirrorFollowUp({
    row: effectiveRow,
    brokerStatus: patch.status,
    session,
    currentPrice: price,
    config: policyConfig(),
  });
  if (plan.action === 'wait') return { proceed: false };
  if (plan.action === 'none') return { proceed: true, note: plan.note };

  const attempt = (Number(row.attempt) > 0 ? Number(row.attempt) : 1) + 1;
  const childBase = {
    trade_id: row.trade_id ?? null,
    symbol: row.symbol,
    side: row.side,
    client_order_id: nextRetryClientOrderId(row.client_order_id, attempt),
    internal_price: row.internal_price, // 偏差基线始终是原内部成交价:追单成本如实入账
    ...(row.account_id ? { account_id: row.account_id } : {}),
    ...(row.source_variant ? { source_variant: row.source_variant } : {}),
    attempt,
    retry_of: row.id,
  };

  // 休市:子行先落 deferred,开盘后以实时价提交(直接重挂会重蹈过期报价的覆辙)
  if (plan.action === 'retry_defer') {
    await insertRow({ ...childBase, qty: plan.qty, limit_price: null, status: 'deferred', note: '休市顺延,待可交易时段以实时价挂单' });
    return { proceed: true, note: plan.note };
  }

  // 重挂/市价升级:卖出数量按券商当前持仓重定(可能已被部分成交/人工平仓)
  let qty = plan.qty;
  if (row.side === 'sell') {
    const pos = await getPosition(row.symbol, creds).catch(() => undefined);
    if (pos === undefined) return { proceed: false };
    qty = adjustSellQty({ internalQty: qty, brokerQty: Number(pos?.qty_available ?? pos?.qty ?? 0) });
    if (!(qty > 0)) return { proceed: true, note: '券商已无持仓,无需重挂' };
  }

  const isMarket = plan.action === 'market_escalate';
  const res = await submitAndRecord({
    base: childBase,
    qty,
    limitPrice: isMarket ? null : plan.limitPrice,
    orderType: isMarket ? 'market' : 'limit',
    extendedHours: isMarket ? false : plan.extendedHours,
    creds,
    logLabel: isMarket ? '市价升级重挂' : '重挂',
  });
  if (!res.ok && !res.permanent) return { proceed: false };
  if (!res.ok) return { proceed: true, note: `重挂被拒: ${String(res.error?.message || '')}`.slice(0, 150) };
  return { proceed: true, note: plan.note };
}

// 对账清理节奏:轮询 60s 一轮 → 约每 30 分钟一次
let pollTicks = 0;
const RECONCILE_EVERY_TICKS = 30;

/** 由调度器周期调用(60s):回填在途对照单的撮合结果、提交顺延单、跟进未成交终态,
 *  并限频写净值对照快照;每 RECONCILE_EVERY_TICKS 轮入队一次对账清理 */
export async function pollMirrorOrders() {
  // env 账户未配置但存在附加账户时照常轮询(025 多账户)
  if (tableMissing || polling) return;
  if (!isBrokerEnabled() && !enabledAccounts().length) return;
  polling = true;
  try {
    // 三级列回退:全列(025+027)→ 剥 attempt/retry_of(027 未迁移,重挂降级)→ 剥 account_id/source_variant(025 未迁移)
    const BASE_COLUMNS = 'id, trade_id, symbol, side, qty, filled_qty, internal_price, broker_order_id, client_order_id, status, submitted_at';
    const runSelect = (columns) =>
      supabase()
        .from('broker_mirror_orders')
        .select(columns)
        .in('status', ['submitted', 'partially_filled', 'deferred'])
        .order('submitted_at', { ascending: true })
        .limit(50);
    let { data: rows, error } = await runSelect(`${BASE_COLUMNS}, account_id, source_variant, attempt, retry_of`);
    if (error && /attempt|retry_of/.test(error.message)) {
      warnRetryColumnsOnce();
      ({ data: rows, error } = await runSelect(`${BASE_COLUMNS}, account_id, source_variant`));
    }
    if (error && /account_id|source_variant/.test(error.message)) {
      ({ data: rows, error } = await runSelect(BASE_COLUMNS));
    }
    if (error) {
      if (isMissingTable(error)) warnMissingOnce();
      else console.warn(`[broker] 读取在途对照单失败: ${error.message}`);
      return;
    }
    let updated = 0;
    for (const row of rows || []) {
      // 归属账户已删除:凭据不可得,标记后不再轮询(绝不能误用 env 凭据查别人的单)
      const account = row.account_id ? accountById(row.account_id) : null;
      if (row.account_id && !account) {
        await patchRow(row.id, { status: 'error', note: '归属账户已删除' });
        continue;
      }
      const creds = credsOf(account);

      // 休市顺延单:开盘后以实时价提交(027)
      if (row.status === 'deferred') {
        if (await submitDeferredRow(row, creds)) updated += 1;
        continue;
      }

      let order = null;
      try {
        order = row.broker_order_id
          ? await getOrder(row.broker_order_id, creds)
          : await getOrderByClientId(row.client_order_id, creds);
      } catch (err) {
        console.warn(`[broker] 查询对照单 #${row.id} 失败: ${err.message}`);
        continue;
      }
      if (!order) {
        await patchRow(row.id, { status: 'error', note: '券商侧未找到订单' });
        continue;
      }
      const patch = fillPatch(order, { side: row.side, internalPrice: row.internal_price });

      // 迁移到未成交终态:先跟进(重挂/升级/放弃),瞬态障碍则不写终态、下轮重放(027)
      if (!retryColumnsMissing && ['expired', 'canceled', 'rejected'].includes(patch.status)) {
        const followUp = await handleTerminalTransition(row, patch, creds);
        if (!followUp.proceed) continue;
        if (followUp.note) patch.note = followUp.note;
      }

      if (patch.status !== row.status || patch.filled_avg_price) {
        if (await patchRow(row.id, patch)) updated += 1;
      }
    }

    // 对账清理:走串行队列,排在所有已入队镜像提交之后(消除"刚卖出又被对账"竞态)
    pollTicks += 1;
    if (config.brokerMirrorReconcile && pollTicks % RECONCILE_EVERY_TICKS === 0 && getMarketSession() !== 'closed') {
      enqueue('对账平仓', reconcileSweep);
    }

    await takeBrokerSnapshots();
    if (updated) console.log(`[broker] 对照单回填 ${updated} 条`);
  } finally {
    polling = false;
  }
}

/**
 * 对账清理(027):平掉"券商持有但内部账本已不持有/超额持有"的仓位 ——
 * 卖单过期滞留的孤儿持仓(重挂机制上线前的存量、市价升级也失败的极端情况)由此自愈。
 * 仅覆盖实盘镜像账户(env 默认 + mirror_actual;影子变体账户需对比各变体虚拟持仓,留作后续)。
 * 平仓单 client_order_id = reconcile-{SYM}-{ET日期}[-a{id}]:每天每票至多发起一次
 * (券商 422 + DB 唯一键双重幂等),后续收敛交给同一套重挂机制;全程 warn-and-continue。
 */
async function reconcileSweep() {
  if (tableMissing || getMarketSession() === 'closed') return;
  const targets = [];
  if (isBrokerEnabled()) targets.push({ account: null, label: '默认账户' });
  for (const acc of accountsForPurpose('mirror_actual')) targets.push({ account: acc, label: acc.label });
  if (!targets.length) return;

  let internalPositions = [];
  try {
    ({ positions: internalPositions } = await getPortfolio());
  } catch (err) {
    console.warn(`[broker] 对账读取内部持仓失败: ${err.message}`);
    return;
  }

  for (const { account, label } of targets) {
    const creds = credsOf(account);
    let brokerPositions = [];
    try {
      brokerPositions = (await getPositions(creds)) || [];
    } catch (err) {
      console.warn(`[broker] 对账读取券商持仓失败(${label}): ${err.message}`);
      continue;
    }
    if (!brokerPositions.length) continue;

    // 有在途镜像单的 symbol 跳过(重挂机制正在收敛);缺 025 列的旧库退回不过滤账户
    let inflightQuery = supabase()
      .from('broker_mirror_orders')
      .select('symbol')
      .in('status', ['submitted', 'partially_filled', 'deferred']);
    inflightQuery = account ? inflightQuery.eq('account_id', account.id) : inflightQuery.is('account_id', null);
    let { data: inflight, error } = await inflightQuery;
    if (error && /account_id/.test(error.message)) {
      ({ data: inflight, error } = await supabase()
        .from('broker_mirror_orders')
        .select('symbol')
        .in('status', ['submitted', 'partially_filled', 'deferred']));
    }
    if (error) {
      console.warn(`[broker] 对账读取在途单失败(${label}): ${error.message}`);
      continue;
    }

    const plans = planReconcile({
      brokerPositions,
      internalPositions,
      inflightSymbols: (inflight || []).map((r) => r.symbol),
    });
    for (const item of plans) {
      const price = await fetchLivePrice(item.symbol, `对账(${label})`);
      if (!price) continue;
      const session = getMarketSession();
      if (session === 'closed') return; // 时段在循环中间关闭:清理只在可交易时段做
      await submitAndRecord({
        base: {
          trade_id: null,
          symbol: item.symbol,
          side: 'sell',
          client_order_id: `reconcile-${item.symbol}-${etDayKey()}${account ? `-a${account.id}` : ''}`,
          // 对账无内部成交价,以清理时实时价为偏差基准(diff_bps 仅度量执行滑点)
          internal_price: price,
          ...(account ? { account_id: account.id } : {}),
          note: item.reason === 'excess' ? `对账减仓:券商多持 ${item.qty} 股` : '对账平仓:内部账本无该持仓',
        },
        qty: item.qty,
        limitPrice: mirrorLimitPrice({ side: 'sell', price, slackPercent: config.brokerMirrorLimitSlackPercent }),
        extendedHours: session !== 'regular',
        creds,
        logLabel: `对账平仓(${label})`,
      });
    }
  }
}

/** 公开 API(/api/broker-mirror)数据源:载荷不含供应商名 */
export async function getBrokerMirrorOverview() {
  if (!isBrokerEnabled()) return { enabled: false };
  if (tableMissing) return { enabled: true, available: false };
  try {
    // 对照卡只看 env 默认账户的实盘镜像(025 多账户后附加账户/影子镜像单不混入);
    // 三级列回退:剥 attempt/retry_of(027 未迁移)→ 剥账户过滤(025 未迁移)
    const OVERVIEW_COLUMNS = 'id, symbol, side, qty, limit_price, status, filled_avg_price, internal_price, diff_bps, note, submitted_at, filled_at';
    const ordersSelect = (columns, filtered) => {
      let q = supabase().from('broker_mirror_orders').select(columns);
      if (filtered) q = q.is('account_id', null).is('source_variant', null);
      return q.order('submitted_at', { ascending: false }).limit(200);
    };
    let [snapRes, ordersRes] = await Promise.all([
      envSnapshotQuery('equity, cash, internal_total_value, created_at', false, 1),
      ordersSelect(`${OVERVIEW_COLUMNS}, attempt, retry_of`, true),
    ]);
    if (ordersRes.error && /attempt|retry_of/.test(ordersRes.error.message)) {
      warnRetryColumnsOnce();
      ordersRes = await ordersSelect(OVERVIEW_COLUMNS, true);
    }
    if (ordersRes.error && /account_id|source_variant/.test(ordersRes.error.message)) {
      ordersRes = await ordersSelect(OVERVIEW_COLUMNS, false);
    }
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

/** 管理重置:撤单+清仓(env 账户 + 全部附加账户)并清空对照表,全部 best-effort;
 *  账户配置(broker_accounts)保留不清。展示主账本缓存/基线一并清除。
 *  与轮询的竞态可接受:truncate 前被在途轮询捞到的行若在清仓后触发重挂,
 *  子单卖出按券商持仓重定量为 0 → 至多留一条 skipped 行,绝不会复活仓位 */
export async function resetBrokerMirror() {
  valuationCache = { at: 0, value: null };
  equityBaseline = undefined;
  if (isBrokerEnabled()) {
    await cancelOpenOrders().catch((err) => console.warn(`[broker] 重置撤单失败: ${err.message}`));
    await closeAllPositions().catch((err) => console.warn(`[broker] 重置清仓失败: ${err.message}`));
  }
  for (const acc of enabledAccounts()) {
    const creds = credsOf(acc);
    await cancelOpenOrders(creds).catch((err) => console.warn(`[broker] 账户 ${acc.label} 重置撤单失败: ${err.message}`));
    await closeAllPositions(creds).catch((err) => console.warn(`[broker] 账户 ${acc.label} 重置清仓失败: ${err.message}`));
  }
  for (const table of ['broker_mirror_orders', 'broker_mirror_snapshots']) {
    const { error } = await supabase().from(table).delete().gte('id', 0);
    if (error && !isMissingTable(error)) {
      console.warn(`[broker] 清空 ${table} 失败: ${error.message}`);
    }
  }
}
