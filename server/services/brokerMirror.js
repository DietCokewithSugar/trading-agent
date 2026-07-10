// 券商模拟对照账本(021):实盘每笔成交镜像到券商模拟账户(marketable 限价单,
// 盘前盘后自动带 extended_hours),轮询回填真实撮合结果,逐笔度量成交价偏差(bps)
// 与账户净值偏离 —— 用真实 NBBO 撮合校准内部滑点模型是偏乐观还是偏悲观。
//
// 027 起镜像单未成交不再一弃了之(否则卖单过期在券商账户滞留孤儿持仓、买单过期永不建仓,
// 两账本永久分歧):休市顺延(status='deferred',开盘后以实时价挂单,不再用过期报价挂必死单)、
// 到期按 mirrorPolicy.js 重挂(卖单限价重试耗尽升级市价单保证收敛;买单限时追单,漂移超限放弃)、
// 定期对账清理滞留持仓(实盘镜像账户对内部账本、影子变体账户对该变体虚拟持仓;unassigned 不清理)。
//
// 镜像账户按现金账户语义运作:买单先过现金约束(planBuyFunding —— 足额提交/有在途卖单
// 回款可期则顺延/否则放弃),绝不动用保证金账户的融资额度;卖出在券商暂无持仓而同票买单
// 在途时顺延等待而非跳过 —— 两者共同保证账户的持仓与现金始终锚定被镜像的账本。
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
  planBuyFunding,
  committedBuyNotional,
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
  cancelOrder,
  cancelOpenOrders,
  closeAllPositions,
} from './alpacaBroker.js';
import { accountsForPurpose, enabledAccounts, accountById, credsOf, primaryBrokerAccount } from './brokerAccounts.js';

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

/**
 * 展示/对照的参照账户(029):管理页指定的主对照账户优先,否则 env 默认账户
 * (ALPACA_KEY_ID/SECRET,自此为遗留可选配置);都没有 → null(对照卡/主账本不可用)。
 * key 用于区分缓存归属(主账户切换后缓存立即失效)。
 */
export function brokerReference() {
  const primary = primaryBrokerAccount();
  if (primary) return { key: `a${primary.id}`, account: primary, creds: credsOf(primary) };
  if (isBrokerEnabled()) return { key: 'env', account: null, creds: null };
  return null;
}

/** 是否存在可用的参照账户(展示主账本/对照卡的可用性判定,替代裸 isBrokerEnabled) */
export function hasBrokerReference() {
  return brokerReference() !== null;
}

// 展示主账本(024):账户+持仓短 TTL 缓存(报价推送循环每几秒一轮,护住券商限频);
// 盈亏基线 = 参照账户最早一条对照快照净值,取一次后常驻(重置/参照切换时失效)
const VALUATION_CACHE_MS = 15_000;
let valuationCache = { key: null, at: 0, value: null };
let equityBaseline = { key: null, value: undefined }; // value: undefined=未取过, null=无快照

// 参照账户的快照过滤(025 多账户后 account_id=null 才是 env 默认账户;缺列=纯旧库,不过滤);
// ltCreatedAt 供统计层做定点查询(今日盈亏锚点/日度收盘回走,brokerStats.js)
export async function referenceSnapshotQuery(ref, columns, { ascending, limit, ltCreatedAt = null } = {}) {
  const build = (filtered) => {
    let q = supabase()
      .from('broker_mirror_snapshots')
      .select(columns)
      .order('created_at', { ascending })
      .limit(limit);
    if (ltCreatedAt) q = q.lt('created_at', ltCreatedAt);
    if (filtered) q = ref.account ? q.eq('account_id', ref.account.id) : q.is('account_id', null);
    return q;
  };
  let { data, error } = await build(true);
  if (error && /account_id/.test(error.message)) {
    ({ data, error } = await build(false));
  }
  return { data, error };
}

/**
 * 参照账户的镜像单查询(brokerStats/对照卡公用):账户过滤 + 两级列回退
 * (fallbackColumns 供剥 attempt/retry_of(027 未迁移)重试;account_id/source_variant
 * 缺列 = 纯旧单账户库,剥账户过滤重试)。apply(q) 由调用方追加过滤/排序/限量。
 */
export async function referenceOrdersQuery(ref, columns, { fallbackColumns = null, apply = (q) => q } = {}) {
  const build = (cols, filtered) => {
    let q = supabase().from('broker_mirror_orders').select(cols);
    if (filtered) {
      q = ref.account ? q.eq('account_id', ref.account.id) : q.is('account_id', null);
      q = q.is('source_variant', null);
    }
    return apply(q);
  };
  let { data, error } = await build(columns, true);
  if (error && fallbackColumns && /attempt|retry_of/.test(error.message)) {
    warnRetryColumnsOnce();
    ({ data, error } = await build(fallbackColumns, true));
  }
  if (error && /account_id|source_variant/.test(error.message)) {
    ({ data, error } = await build(fallbackColumns || columns, false));
  }
  return { data, error };
}

export async function loadEquityBaseline(ref) {
  if (equityBaseline.key === ref.key && equityBaseline.value !== undefined) return equityBaseline.value;
  try {
    const { data, error } = await referenceSnapshotQuery(ref, 'equity', { ascending: true, limit: 1 });
    if (error) throw new Error(error.message);
    equityBaseline = { key: ref.key, value: data?.length ? Number(data[0].equity) : null };
  } catch {
    equityBaseline = { key: ref.key, value: null };
  }
  return equityBaseline.value;
}

/**
 * 券商模拟账户实时估值(展示主账本,024):参照账户+全部持仓映射为 getValuation 形状。
 * 15s TTL 缓存;取数失败向上抛,由 primaryLedger 兜底回退内部账本(fail-open)。
 */
export async function getBrokerValuation() {
  const ref = brokerReference();
  if (!ref) throw new Error('券商模拟账户未配置');
  if (valuationCache.key === ref.key && valuationCache.value && Date.now() - valuationCache.at < VALUATION_CACHE_MS) {
    return valuationCache.value;
  }
  const [account, positions, baseline] = await Promise.all([
    getAccount(ref.creds),
    getPositions(ref.creds),
    loadEquityBaseline(ref),
  ]);
  const value = buildBrokerValuation({
    account,
    positions,
    baseline,
    session: getMarketSession(),
  });
  valuationCache = { key: ref.key, at: Date.now(), value };
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

/** 券商净值时间序列(展示主账本的净值曲线,参照账户):升序;失败抛错由调用方回退 */
export async function getBrokerSnapshots(sinceIso) {
  const ref = brokerReference();
  if (!ref) throw new Error('券商模拟账户未配置');
  const baseline = await loadEquityBaseline(ref);
  const build = (filtered) => {
    // 倒序取最近窗口再反转:30s 快照节奏下升序 + limit 会永远卡在最老的 5000 行,
    // 账户运行几天后曲线就冻结在早期
    let q = supabase()
      .from('broker_mirror_snapshots')
      .select('equity, cash, created_at')
      .order('created_at', { ascending: false })
      .limit(5000);
    if (filtered) q = ref.account ? q.eq('account_id', ref.account.id) : q.is('account_id', null);
    if (sinceIso) q = q.gte('created_at', sinceIso);
    return q;
  };
  let { data, error } = await build(true);
  if (error && /account_id/.test(error.message)) {
    ({ data, error } = await build(false));
  }
  if (error) throw new Error(error.message);
  // 30s 快照粒度下行数远超图表可用点数:均匀降采样到 ≤600 点(保首尾)
  let rows = (data || []).reverse();
  if (rows.length > 600) {
    const step = (rows.length - 1) / 599;
    rows = Array.from({ length: 600 }, (_, i) => rows[Math.round(i * step)]);
  }
  return rows.map((row) => mapBrokerSnapshotRow(row, baseline)).filter(Boolean);
}

/** 最新券商快照(snapshot SSE 广播用,参照账户);无数据/失败返回 null */
export async function getLatestBrokerSnapshot() {
  try {
    const ref = brokerReference();
    if (!ref) return null;
    const baseline = await loadEquityBaseline(ref);
    const { data, error } = await referenceSnapshotQuery(ref, 'equity, cash, created_at', { ascending: false, limit: 1 });
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
    // 顺延买单超龄作废时效复用实盘挂单时效(PENDING_ORDER_MAX_AGE_HOURS)
    deferredBuyMaxAgeHours: config.pendingOrderMaxAgeHours,
  };
}

/**
 * 该账户的在途镜像单(submitted/partially_filled/deferred),可按方向/标的过滤。
 * 查询失败返回 null(调用方按"未知"保守处理:买单资金判定当有回款可期继续等,
 * 无持仓卖单判定当买单在途继续顺延 —— 两者都有确定的终点兜底)。
 */
async function listInflightOrders(account, { side = null, symbol = null } = {}) {
  const build = (filtered) => {
    let query = supabase()
      .from('broker_mirror_orders')
      .select('symbol, side, status, qty, filled_qty, limit_price, internal_price')
      .in('status', ['submitted', 'partially_filled', 'deferred']);
    if (filtered) query = account ? query.eq('account_id', account.id) : query.is('account_id', null);
    if (side) query = query.eq('side', side);
    if (symbol) query = query.eq('symbol', symbol);
    return query;
  };
  let { data, error } = await build(true);
  // 025 未迁移(无 account_id 列):必然也没有附加账户,退回不过滤账户
  if (error && /account_id/.test(error.message)) {
    ({ data, error } = await build(false));
  }
  if (error) {
    console.warn(`[broker] 读取在途镜像单失败: ${error.message}`);
    return null;
  }
  return data || [];
}

/**
 * 账户可用现金(禁用保证金):cash 与 non_marginable_buying_power 取更小的有限值。
 * 注意 cash 只在成交时变动、不含挂单冻结,NMBP 语义也不可尽信 —— 挂单占用由调用方
 * 用本地在途买单记账(committedBuyNotional)扣除;读数失败返回 null(调用方顺延重试)。
 */
async function fetchAvailableCash(creds) {
  try {
    const account = await getAccount(creds);
    const values = [Number(account?.cash), Number(account?.non_marginable_buying_power)].filter((v) =>
      Number.isFinite(v)
    );
    return values.length ? Math.min(...values) : null;
  } catch (err) {
    console.warn(`[broker] 读取账户现金失败: ${err.message}`);
    return null;
  }
}

/**
 * 镜像买单资金决策(planBuyFunding 的 IO 包装):
 *  - 可用现金 = min(cash, NMBP) − 在途买单占用(committedBuyNotional,本地记账 ——
 *    cash 不含挂单冻结,串行连发的买单否则会各自读到同一余额集体超买);
 *  - 回款可期 = 存在在途卖单,但排除同票顺延卖单 —— 它在等本买单的持仓落地,
 *    互相等待即死锁(顺延买单时效是最终兜底)。
 * 在途单读数不可得时按 wait 处理(既不能算占用也不能判回款,宁等待不冒进)。
 */
async function buyFundingPlan({ account, creds, symbol, qty, limitPrice }) {
  const cash = await fetchAvailableCash(creds);
  if (cash === null) return { action: 'wait' };
  const inflight = await listInflightOrders(account, {});
  if (inflight === null) return { action: 'wait' };
  const committed = committedBuyNotional(inflight.filter((r) => r.status !== 'deferred'));
  const hasProceeds = inflight.some(
    (r) => r.side === 'sell' && !(r.status === 'deferred' && r.symbol === symbol)
  );
  return planBuyFunding({
    notional: Number(qty) * Number(limitPrice),
    availableCash: cash - committed,
    hasPendingSellProceeds: hasProceeds,
  });
}

/**
 * 共享提交助手(首挂/顺延提交/重挂/对账共用):提交券商订单并落库
 * (existingRowId 为空插新行,否则 in-place 更新该 deferred 行)。
 * 幂等:422 重复 client_order_id → 取回既有订单按其状态落库(崩溃重放安全);
 * 碎股 422 → 退整数股,不足 1 股记 skipped;其余参数级 422 → 落 error 终态防死循环。
 * 网络/5xx 瞬态失败不落新行,调用方按 { ok:false, permanent:false } 自行顺延/重放。
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
    if (err.status === 422 || err.status === 403) {
      // 参数级拒绝(标的不可交易等)与 403(买力不足/账户受限 —— 资金约束在提交前
      // 已把正常情形挡掉,走到这里的 403 重试也不会好):落 error 终态,防止无限重放
      await recordTerminal('error', String(err.message).slice(0, 200));
      return { ok: false, permanent: true, error: err };
    }
    // 网络/5xx 瞬态:不落行,由调用方顺延(首挂落 deferred 行)或下轮重放(轮询路径)
    return { ok: false, permanent: false, error: err };
  }
}

/**
 * 镜像下单核心(025 起多账户):account=null 为 env 默认账户;
 * sourceVariant 非空表示镜像的是该影子变体的买卖(trade 为影子成交行)。
 * 幂等键按账户隔离(trade-{id} / shadow-{id} + -a{accountId} 后缀)。
 * 休市时段不直接提交(当日限价单必然过期,且限价基于过期报价):落 deferred 行,
 * 开盘后由轮询以实时价挂单;卖出定量同样推迟到提交时。
 * 买入先过现金约束(禁用保证金);卖出在券商暂无持仓而同票买单在途时顺延;
 * 瞬态失败(持仓查询/提交)一律落 deferred 由轮询重放,绝不静默丢单。
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
    if (pos === undefined) {
      // 查询瞬态失败不丢单(此前直接抛错,这笔镜像卖出一去不返 → 券商滞留孤儿持仓):
      // 落 deferred 由轮询以实时价重试
      await insertRow({ ...base, qty, limit_price: null, status: 'deferred', note: '查询券商持仓失败,顺延重试' });
      return;
    }
    qty = adjustSellQty({
      internalQty: qty,
      brokerQty: Number(pos?.qty_available ?? pos?.qty ?? 0),
    });
    if (!(qty > 0)) {
      // 券商暂无持仓:若同票买单还在途(已提交未成交/顺延待提交),买单落地后这笔卖出
      // 必须执行,否则该持仓成为孤儿 —— 落 deferred 等买单出结果(成交 → 重定数量卖出;
      // 放弃 → 顺延卖出自然收敛为 skipped)。确实无持仓且无在途买单才是真正的跳过
      const inflightBuys = await listInflightOrders(account, { side: 'buy', symbol });
      if (inflightBuys === null || inflightBuys.length) {
        await insertRow({
          ...base,
          qty: Number(trade.quantity),
          limit_price: null,
          status: 'deferred',
          note: '券商暂无持仓且同票买单在途,待买单落地后卖出',
        });
        return;
      }
      await insertRow({ ...base, qty: 0, status: 'skipped', note: '券商账户无该持仓,跳过镜像卖出' });
      return;
    }
  }

  const limitPrice = mirrorLimitPrice({ side, price: internalPrice, slackPercent: config.brokerMirrorLimitSlackPercent });

  // 买入:现金约束(镜像账户绝不动用保证金)。不足但有在途卖单回款可期 → 顺延;
  // 不足且无回款可期 → 放弃(内部已成交而券商未镜像,如实计入未成交)
  if (side === 'buy') {
    const funding = await buyFundingPlan({ account, creds, symbol, qty, limitPrice });
    if (funding.action === 'wait') {
      await insertRow({ ...base, qty, limit_price: null, status: 'deferred', note: funding.note ?? '待账户现金就绪后提交' });
      console.log(`[broker] ${label} ${side} ${symbol} ×${qty} 现金未就绪,顺延`);
      return;
    }
    if (funding.action === 'abandon') {
      await insertRow({ ...base, qty, limit_price: null, status: 'abandoned', note: funding.note });
      console.warn(`[broker] ${label} ${side} ${symbol} ×${qty} ${funding.note}`);
      return;
    }
  }

  const res = await submitAndRecord({
    base,
    qty,
    limitPrice,
    extendedHours: session !== 'regular',
    creds,
    logLabel: label,
  });
  if (!res.ok && !res.permanent) {
    // 网络/5xx 瞬态失败不再落 error 终态丢单:落 deferred 由轮询重放
    // (幂等键保证即使订单实际已到达券商,重放也只会取回既有订单落库)
    await insertRow({
      ...base,
      qty,
      limit_price: limitPrice,
      status: 'deferred',
      note: `提交瞬态失败,顺延重试: ${String(res.error?.message || '').slice(0, 150)}`,
    });
    return;
  }
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
 * 实盘镜像用途(mirror_actual)的附加账户同样记录同时刻内部净值(029)——
 * 它们与内部账本可比,主对照账户的对照卡 diff 依赖这一列。
 */
export async function takeBrokerSnapshots() {
  if (tableMissing) return;
  if (Date.now() - lastSnapshotAt < snapshotIntervalMs()) return;
  lastSnapshotAt = Date.now();
  const needInternal =
    isBrokerEnabled() || enabledAccounts().some((a) => a.purpose === 'mirror_actual');
  const valuation = needInternal ? await getValuation().catch(() => null) : null;
  if (isBrokerEnabled()) {
    try {
      const account = await getAccount();
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
        internal_total_value: acc.purpose === 'mirror_actual' ? (valuation?.total_value ?? null) : null,
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

/**
 * 顺延单放弃前的收编检查(崩溃窗口兜底):submitOrder 成功但落库前进程崩溃时,
 * 行仍是 deferred 而券商侧订单已在场内 —— 直接 abandoned 会让后续成交无人跟踪。
 * 放弃前按幂等键查一次:订单存在即按其真实状态收编落库;查询失败下轮重放。
 */
async function abandonDeferredRow(row, creds, note) {
  const existing = await getOrderByClientId(row.client_order_id, creds).catch(() => undefined);
  if (existing === undefined) return false; // 查询失败:不写终态,下轮重放
  if (existing) {
    return patchRow(row.id, {
      submitted_at: new Date().toISOString(),
      ...fillPatch(existing, { side: row.side, internalPrice: row.internal_price }),
    });
  }
  return patchRow(row.id, { status: 'abandoned', note });
}

/** 顺延单(deferred)提交:开盘后以实时价挂单;返回是否写了行(计入回填数) */
async function submitDeferredRow(row, account, creds) {
  const session = getMarketSession();
  const plan = planMirrorFollowUp({ row, session, currentPrice: null, config: policyConfig() });
  // 超龄作废不依赖时段/报价(顺延买单时效),先于一切检查
  if (plan.action === 'abandon') {
    return abandonDeferredRow(row, creds, plan.note);
  }
  if (session === 'closed') return false;
  const price = await fetchLivePrice(row.symbol, `顺延单 #${row.id}`);
  const livePlan = planMirrorFollowUp({ row, session, currentPrice: price, config: policyConfig() });
  if (livePlan.action === 'wait') return false;
  if (livePlan.action === 'abandon') {
    return abandonDeferredRow(row, creds, livePlan.note);
  }
  // submit_deferred:卖出数量按券商当前持仓重定
  let qty = Number(row.qty);
  if (row.side === 'sell') {
    const pos = await getPosition(row.symbol, creds).catch(() => undefined);
    if (pos === undefined) return false; // 查持仓失败,下轮重试
    qty = adjustSellQty({ internalQty: qty, brokerQty: Number(pos?.qty_available ?? pos?.qty ?? 0) });
    if (!(qty > 0)) {
      // 同票买单在途(已提交未成交/顺延待提交):持仓可能马上落地,继续等;
      // 买单已放弃/成交后仍无持仓才收敛为 skipped
      const inflightBuys = await listInflightOrders(account, { side: 'buy', symbol: row.symbol });
      if (inflightBuys === null || inflightBuys.length) return false;
      return patchRow(row.id, { status: 'skipped', note: '券商已无持仓且无在途买单,跳过顺延卖出' });
    }
  }
  // 买入:提交前再过一次现金约束(顺延期间账户状态可能已变)
  if (row.side === 'buy') {
    const funding = await buyFundingPlan({ account, creds, symbol: row.symbol, qty, limitPrice: livePlan.limitPrice });
    if (funding.action === 'wait') return false;
    if (funding.action === 'abandon') {
      return abandonDeferredRow(row, creds, funding.note);
    }
  }
  // 长期无报价的顺延卖单升级市价单(market_escalate),其余按实时限价提交
  const isMarket = livePlan.action === 'market_escalate';
  const res = await submitAndRecord({
    base: row,
    qty,
    limitPrice: isMarket ? null : livePlan.limitPrice,
    orderType: isMarket ? 'market' : 'limit',
    extendedHours: isMarket ? false : livePlan.extendedHours,
    creds,
    existingRowId: row.id,
    logLabel: isMarket ? '顺延单市价升级' : '顺延单提交',
  });
  return res.ok;
}

/**
 * 在途单迁移到未成交终态时的跟进(027):按 mirrorPolicy 决策重挂/升级/放弃。
 * 返回 { proceed, note? }:proceed=false 表示瞬态障碍(报价/持仓查询失败、瞬态提交失败),
 * 调用方本轮不写终态 patch,下轮重放整个迁移;note 追加进父行终态 patch。
 * 顺序:先提交/落子行,最后才写父行终态 —— 崩溃在任何一步都能靠幂等键安全重放。
 */
async function handleTerminalTransition(row, patch, account, creds) {
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

  // 买单追挂同样受现金约束(禁用保证金):回款可期则整个迁移下轮重放,否则放弃追单
  if (row.side === 'buy' && plan.action === 'retry_limit') {
    const funding = await buyFundingPlan({ account, creds, symbol: row.symbol, qty: plan.qty, limitPrice: plan.limitPrice });
    if (funding.action === 'wait') return { proceed: false };
    if (funding.action === 'abandon') return { proceed: true, note: `放弃追单:${funding.note}` };
  }

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
        if (await submitDeferredRow(row, account, creds)) updated += 1;
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

      // 陈旧在途限价单主动撤单重挂:day 限价单不成交要等收盘过期才进重挂链(最坏拖数日,
      // 出场时效远落后于被镜像账本的 ±2% 括号)—— 超过 BROKER_MIRROR_REPRICE_MINUTES 仍
      // 在场内工作的限价单主动撤掉,下轮观察到 canceled 终态后由既有重挂链按实时价重挂。
      // 仅限价单(市价单排队必成交)、仅可交易时段(休市撤了也只能顺延)、重挂机制可用时才撤
      const rowAgeMs = Date.now() - Date.parse(row.submitted_at ?? '');
      if (
        !retryColumnsMissing &&
        config.brokerMirrorRepriceMinutes > 0 &&
        ['submitted', 'partially_filled'].includes(patch.status) &&
        row.limit_price !== null &&
        row.limit_price !== undefined &&
        getMarketSession() !== 'closed' &&
        Number.isFinite(rowAgeMs) &&
        rowAgeMs > config.brokerMirrorRepriceMinutes * 60_000
      ) {
        const brokerOrderId = order.id || row.broker_order_id;
        if (brokerOrderId) {
          await cancelOrder(brokerOrderId, creds).catch((err) =>
            console.warn(`[broker] 对照单 #${row.id} 陈旧撤单失败(下轮重试): ${err.message}`)
          );
          console.log(`[broker] 对照单 #${row.id} ${row.side} ${row.symbol} 超 ${config.brokerMirrorRepriceMinutes} 分钟未成交,已撤单待重挂`);
        }
      }

      // 迁移到未成交终态:先跟进(重挂/升级/放弃),瞬态障碍则不写终态、下轮重放(027)
      if (!retryColumnsMissing && ['expired', 'canceled', 'rejected'].includes(patch.status)) {
        const followUp = await handleTerminalTransition(row, patch, account, creds);
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
 * 对账清理(027):平掉"券商持有但对账基准账本已不持有/超额持有"的仓位 ——
 * 卖单过期滞留的孤儿持仓(重挂机制上线前的存量、市价升级也失败的极端情况)由此自愈。
 * 对账基准:实盘镜像账户(env 默认 + mirror_actual)对内部账本持仓;影子变体账户对
 * 该变体的 shadow_positions(卖出镜像被跳过/碎股残留造成的滞留持仓同样自愈);
 * unassigned 账户不清理(闲置账户可能被人工使用,清仓属破坏性操作)。
 * 平仓单 client_order_id = reconcile-{SYM}-{ET日期}[-a{id}]:每天每票至多发起一次
 * (券商 422 + DB 唯一键双重幂等),后续收敛交给同一套重挂机制;全程 warn-and-continue。
 */
async function reconcileSweep() {
  if (tableMissing || getMarketSession() === 'closed') return;
  const targets = [];
  if (isBrokerEnabled()) targets.push({ account: null, label: '默认账户', variant: null });
  for (const acc of enabledAccounts()) {
    if (acc.purpose === 'mirror_actual') targets.push({ account: acc, label: acc.label, variant: null });
    else if (acc.purpose !== 'unassigned') targets.push({ account: acc, label: acc.label, variant: acc.purpose });
  }
  if (!targets.length) return;

  // 实盘对账基准(内部账本持仓)只在存在实盘镜像目标时读一次
  let internalPositions = null;
  if (targets.some((t) => !t.variant)) {
    try {
      ({ positions: internalPositions } = await getPortfolio());
    } catch (err) {
      console.warn(`[broker] 对账读取内部持仓失败: ${err.message}`);
    }
  }

  for (const { account, label, variant } of targets) {
    // 每个目标的对账基准:影子变体账户 → 该变体虚拟持仓;实盘镜像账户 → 内部账本持仓
    let refPositions;
    if (variant) {
      const { data, error } = await supabase()
        .from('shadow_positions')
        .select('symbol, quantity')
        .eq('variant', variant);
      if (error) {
        console.warn(`[broker] 对账读取影子持仓失败(${label}/${variant}): ${error.message}`);
        continue;
      }
      refPositions = data || [];
    } else {
      if (!internalPositions) continue; // 内部持仓读取失败,本轮跳过实盘镜像目标
      refPositions = internalPositions;
    }
    const creds = credsOf(account);
    let brokerPositions = [];
    try {
      brokerPositions = (await getPositions(creds)) || [];
    } catch (err) {
      console.warn(`[broker] 对账读取券商持仓失败(${label}): ${err.message}`);
      continue;
    }
    if (!brokerPositions.length) continue;

    // 有在途镜像单的 symbol 跳过(重挂机制正在收敛);缺 025 列的旧库退回不过滤账户。
    // 例外:顺延中的买单(deferred buy)不算在途 —— 它没在券商侧锁任何东西,却可能
    // 等现金等最长 96h,不能让同票孤儿持仓的清理被它长期阻塞
    const inflight = await listInflightOrders(account, {});
    if (inflight === null) {
      console.warn(`[broker] 对账读取在途单失败(${label}),本轮跳过该账户`);
      continue;
    }

    const plans = planReconcile({
      brokerPositions,
      internalPositions: refPositions,
      inflightSymbols: inflight
        .filter((r) => !(r.side === 'buy' && r.status === 'deferred'))
        .map((r) => r.symbol),
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
          ...(variant ? { source_variant: variant } : {}),
          note: item.reason === 'excess' ? `对账减仓:券商多持 ${item.qty} 股` : '对账平仓:对账基准账本无该持仓',
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
  const ref = brokerReference();
  if (!ref) return { enabled: false };
  if (tableMissing) return { enabled: true, available: false };
  try {
    // 对照卡只看参照账户的实盘镜像(管理页主对照账户优先,否则 env 默认账户;
    // 其余附加账户/影子镜像单不混入);列回退在 referenceOrdersQuery 内公用
    const OVERVIEW_COLUMNS = 'id, symbol, side, qty, limit_price, status, filled_avg_price, internal_price, diff_bps, note, submitted_at, filled_at';
    const [snapRes, ordersRes] = await Promise.all([
      referenceSnapshotQuery(ref, 'equity, cash, internal_total_value, created_at', { ascending: false, limit: 1 }),
      referenceOrdersQuery(ref, `${OVERVIEW_COLUMNS}, attempt, retry_of`, {
        fallbackColumns: OVERVIEW_COLUMNS,
        apply: (q) => q.order('submitted_at', { ascending: false }).limit(200),
      }),
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

/** 管理重置:撤单+清仓(env 账户 + 全部附加账户)并清空对照表,全部 best-effort;
 *  账户配置(broker_accounts)保留不清。展示主账本缓存/基线一并清除。
 *  与轮询的竞态可接受:truncate 前被在途轮询捞到的行若在清仓后触发重挂,
 *  子单卖出按券商持仓重定量为 0 → 至多留一条 skipped 行,绝不会复活仓位 */
export async function resetBrokerMirror() {
  valuationCache = { key: null, at: 0, value: null };
  equityBaseline = { key: null, value: undefined };
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

/**
 * 单账户清仓重置(管理页,029):撤掉该账户全部券商挂单、市价清空全部持仓
 * (休市/盘外提交的市价单排队到下一常规时段),并把该账户的在途/顺延镜像单作废 ——
 * 防止撤单被重挂链当成未成交去追挂,清仓后又把仓位买回来。
 * 账户配置与历史终态单据保留;券商侧失败向上抛(由路由报错给管理员)。
 */
export async function liquidateBrokerAccount(id) {
  const account = accountById(Number(id));
  if (!account) {
    const err = new Error(`账户 #${id} 不存在`);
    err.status = 404;
    throw err;
  }
  const creds = credsOf(account);
  await cancelOpenOrders(creds);
  await closeAllPositions(creds);
  const { error } = await supabase()
    .from('broker_mirror_orders')
    .update({ status: 'abandoned', note: '管理员清仓重置', updated_at: new Date().toISOString() })
    .eq('account_id', account.id)
    .in('status', ['submitted', 'partially_filled', 'deferred']);
  if (error && !isMissingTable(error) && !/account_id/.test(error.message)) {
    console.warn(`[broker] 账户 ${account.label} 清仓后作废在途单失败: ${error.message}`);
  }
  // 该账户若正是参照账户,估值缓存立即失效(下一次取数反映清仓后状态)
  if (valuationCache.key === `a${account.id}`) valuationCache = { key: null, at: 0, value: null };
  console.log(`[broker] 账户 ${account.label} 已清仓重置(撤单+清仓+作废在途镜像单)`);
  return { id: account.id, label: account.label };
}
