// 多券商模拟账户(025):管理员页添加多个券商模拟账户(API key 存库,RLS 无公共读),
// 每个账户可指派一个消融变体作为用途——该变体此后的每笔影子成交都以 marketable
// 限价单发往对应账户,用真实盘口撮合复演消融实验(影子账本 vs 券商真实撮合)。
//
// 观测层三约定(与 021 实盘对照账本一致):
//  - fire-and-forget:执行经进程内串行队列,任何失败只告警,绝不影响交易/影子主链路;
//  - broker_accounts 表缺失(025 未执行)警告一次后停用;
//  - 幂等:client_order_id = shadow-{shadow_trade_id},券商侧拒绝重复,防止重复执行。
//
// 安全约定:secret_key 只进不出(接口永不返回);key_id 输出前脱敏(maskKeyId)。
// 日志前缀 [accounts]。
import { supabase } from '../db.js';
import { config } from '../config.js';
import { getMarketSession } from './fmp.js';
import { makeBrokerClient } from './alpacaBroker.js';
import { mirrorLimitPrice, signedDiffBps, adjustSellQty, summarizeMirror } from './brokerMirror.js';

// ── 纯函数(node:test 直接测)──

/** key_id 脱敏:保留前 2 + 后 4 位,中间以 **** 代替;过短的整体打码 */
export function maskKeyId(keyId) {
  const s = String(keyId || '');
  if (s.length <= 6) return s ? '****' : '';
  return `${s.slice(0, 2)}****${s.slice(-4)}`;
}

/**
 * 新增账户入参校验:返回错误消息数组(空数组 = 通过)。
 * base_url 仅接受 https(密钥随请求头发送,明文端点等于泄露);
 * 本地回环地址(localhost/127.0.0.1)放行 http,供本地联调/模拟端点使用。
 */
export function validateAccountInput({ name, keyId, secretKey, baseUrl = null } = {}) {
  const errors = [];
  if (!String(name || '').trim()) errors.push('账户名称不能为空');
  if (String(name || '').trim().length > 50) errors.push('账户名称过长(≤50 字符)');
  if (!String(keyId || '').trim()) errors.push('API Key ID 不能为空');
  if (!String(secretKey || '').trim()) errors.push('API Secret 不能为空');
  if (baseUrl) {
    let ok = false;
    try {
      const url = new URL(String(baseUrl).trim());
      ok =
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
    } catch {
      ok = false;
    }
    if (!ok) errors.push('接口地址必须是 https://(本地回环地址可用 http)');
  }
  return errors;
}

// ── 运行时状态 ──

let accounts = []; // 含密钥的完整行,常驻内存(启动加载,CRUD 后刷新);仅本模块内部使用
let tableMissing = false;
let loaded = false;

function isMissingTable(error) {
  return (
    error?.code === 'PGRST205' ||
    (/broker_account/.test(error?.message || '') &&
      /not find|does not exist|schema cache/i.test(error?.message || ''))
  );
}

function warnMissingOnce() {
  if (tableMissing) return;
  tableMissing = true;
  console.warn('[accounts] broker_accounts 表不可用,多券商模拟账户停用(请执行 025 迁移)');
}

export function isAccountsAvailable() {
  return loaded && !tableMissing;
}

function clientFor(account) {
  return makeBrokerClient({
    keyId: account.key_id,
    secretKey: account.secret_key,
    baseUrl: account.base_url || null,
  });
}

/** 服务启动时加载账户到内存;缺表/无 Supabase 配置时静默停用,绝不抛错 */
export async function loadBrokerAccounts() {
  try {
    const { data, error } = await supabase().from('broker_accounts').select('*');
    if (error) {
      if (isMissingTable(error)) warnMissingOnce();
      else console.warn(`[accounts] 加载券商账户失败: ${error.message}`);
      return;
    }
    accounts = data || [];
    loaded = true;
    const assigned = accounts.filter((a) => a.enabled && a.purpose);
    if (assigned.length) {
      console.log(
        `[accounts] 券商模拟账户就绪: ${accounts.length} 个,已指派 ${assigned
          .map((a) => `${a.name}→${a.purpose}`)
          .join(' / ')}`
      );
    }
  } catch (err) {
    if (!/Supabase 未配置/.test(err.message)) {
      console.warn(`[accounts] 加载券商账户失败: ${err.message}`);
    }
  }
}

// ── 管理面 CRUD(admin 路由调用;错误带 status 供 asyncHandler 映射)──

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** 脱敏输出行(secret 永不返回) */
function toPublicRow(row) {
  return {
    id: row.id,
    name: row.name,
    key_id_masked: maskKeyId(row.key_id),
    base_url_custom: Boolean(row.base_url),
    purpose: row.purpose || null,
    enabled: row.enabled,
    status: row.status || null,
    last_error: row.last_error || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 新增账户:先向券商校验连通性(校验失败 400,不入库),再落库并刷新内存。
 * 密钥只在这一刻经手,之后仅从库/内存读取。
 */
export async function addBrokerAccount({ name, keyId, secretKey, baseUrl = null }) {
  if (tableMissing) throw httpError(409, 'broker_accounts 表不可用,请执行 025 迁移');
  const errors = validateAccountInput({ name, keyId, secretKey, baseUrl });
  if (errors.length) throw httpError(400, errors.join(';'));

  let equity = null;
  try {
    const account = await makeBrokerClient({
      keyId: String(keyId).trim(),
      secretKey: String(secretKey).trim(),
      baseUrl: baseUrl ? String(baseUrl).trim() : null,
    }).getAccount();
    equity = Number(account?.equity);
    if (!account || !Number.isFinite(equity)) throw new Error('账户信息异常(无净值字段)');
  } catch (err) {
    throw httpError(400, `券商账户校验失败,未保存: ${String(err.message).slice(0, 160)}`);
  }

  const { data, error } = await supabase()
    .from('broker_accounts')
    .insert({
      name: String(name).trim(),
      key_id: String(keyId).trim(),
      secret_key: String(secretKey).trim(),
      base_url: baseUrl ? String(baseUrl).trim() : null,
      status: 'ok',
      last_error: null,
    })
    .select('*')
    .single();
  if (error) {
    if (isMissingTable(error)) {
      warnMissingOnce();
      throw httpError(409, 'broker_accounts 表不可用,请执行 025 迁移');
    }
    throw httpError(500, `保存券商账户失败: ${error.message}`);
  }
  await loadBrokerAccounts();
  console.log(`[accounts] 新增券商模拟账户「${data.name}」(#${data.id},净值 $${equity})`);
  return toPublicRow(data);
}

/**
 * 更新账户(name/purpose/enabled):purpose 由路由先按变体白名单校验;
 * 同一用途唯一索引冲突时报 409。重新指派不迁移券商侧既有持仓(管理页文案已注明)。
 */
export async function updateBrokerAccount(id, patch) {
  if (tableMissing) throw httpError(409, 'broker_accounts 表不可用,请执行 025 迁移');
  const allowed = {};
  if (patch.name !== undefined) {
    if (!String(patch.name || '').trim()) throw httpError(400, '账户名称不能为空');
    allowed.name = String(patch.name).trim().slice(0, 50);
  }
  if (patch.purpose !== undefined) allowed.purpose = patch.purpose || null;
  if (patch.enabled !== undefined) allowed.enabled = Boolean(patch.enabled);
  if (!Object.keys(allowed).length) throw httpError(400, '没有可更新的字段');
  allowed.updated_at = new Date().toISOString();

  const { data, error } = await supabase()
    .from('broker_accounts')
    .update(allowed)
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) {
    if (error.code === '23505' || /duplicate key|unique/i.test(error.message)) {
      throw httpError(409, '该用途已被其他启用中的账户占用(同一变体最多绑定一个账户)');
    }
    throw httpError(500, `更新券商账户失败: ${error.message}`);
  }
  if (!data) throw httpError(404, '账户不存在');
  await loadBrokerAccounts();
  console.log(`[accounts] 更新券商模拟账户 #${id}: ${JSON.stringify({ ...allowed, updated_at: undefined })}`);
  return toPublicRow(data);
}

/** 删除账户:先 best-effort 撤销该账户在券商侧的未成交单,再删行(orders/snapshots 级联) */
export async function deleteBrokerAccount(id) {
  if (tableMissing) throw httpError(409, 'broker_accounts 表不可用,请执行 025 迁移');
  const row = accounts.find((a) => a.id === Number(id));
  if (row) {
    await clientFor(row)
      .cancelOpenOrders()
      .catch((err) => console.warn(`[accounts] 删除前撤单失败(可忽略): ${err.message}`));
  }
  const { error } = await supabase().from('broker_accounts').delete().eq('id', id);
  if (error) throw httpError(500, `删除券商账户失败: ${error.message}`);
  await loadBrokerAccounts();
  console.log(`[accounts] 删除券商模拟账户 #${id}`);
  return { ok: true };
}

/**
 * 管理面总览:全部账户(脱敏)+ 每账户成交统计(最近 200 单)与最新净值快照。
 * 表缺失返回 { available: false }。
 */
export async function getBrokerAccountsOverview() {
  if (tableMissing) return { available: false, accounts: [] };
  try {
    const [accRes, ordersRes, snapsRes] = await Promise.all([
      supabase().from('broker_accounts').select('*').order('id'),
      supabase()
        .from('broker_account_orders')
        .select('account_id, side, status, diff_bps, symbol, qty, limit_price, filled_avg_price, internal_price, note, submitted_at, filled_at, id')
        .order('submitted_at', { ascending: false })
        .limit(200),
      // 每账户最新一条快照:按时间倒序取一批后在 JS 里去重(账户数少,足够)
      supabase()
        .from('broker_account_snapshots')
        .select('account_id, equity, cash, shadow_total_value, created_at')
        .order('created_at', { ascending: false })
        .limit(100),
    ]);
    if (accRes.error) {
      if (isMissingTable(accRes.error)) {
        warnMissingOnce();
        return { available: false, accounts: [] };
      }
      throw new Error(accRes.error.message);
    }
    const orders = ordersRes.error ? [] : ordersRes.data || [];
    const snaps = snapsRes.error ? [] : snapsRes.data || [];
    const latestSnap = new Map();
    for (const s of snaps) {
      if (!latestSnap.has(s.account_id)) latestSnap.set(s.account_id, s);
    }
    const rows = (accRes.data || []).map((a) => {
      const own = orders.filter((o) => o.account_id === a.id);
      const snap = latestSnap.get(a.id) || null;
      return {
        ...toPublicRow(a),
        stats: summarizeMirror(own),
        recent: own.slice(0, 5),
        equity: snap ? Number(snap.equity) : null,
        shadow_total_value: snap?.shadow_total_value !== null && snap?.shadow_total_value !== undefined
          ? Number(snap.shadow_total_value)
          : null,
        snapshot_at: snap?.created_at || null,
      };
    });
    return { available: true, accounts: rows };
  } catch (err) {
    console.warn(`[accounts] 账户总览失败: ${err.message}`);
    return { available: true, accounts: [], error: '账户总览暂不可用' };
  }
}

// ── 影子成交执行(shadowPortfolio 调用,fire-and-forget)──

// 进程内串行队列:同一轮多笔影子成交逐个提交,避免并发打爆券商限频
let chain = Promise.resolve();
function enqueue(label, fn) {
  chain = chain
    .then(fn)
    .catch((err) => console.warn(`[accounts] ${label} 失败: ${err.message}`));
}

/** 券商订单状态 → 本地状态(未识别的中间态一律按在途处理);与 brokerMirror 同口径 */
function mapStatus(brokerStatus) {
  const s = String(brokerStatus || '');
  if (['filled', 'partially_filled', 'canceled', 'expired', 'rejected'].includes(s)) return s;
  return 'submitted';
}

async function insertRow(row) {
  const { error } = await supabase().from('broker_account_orders').insert(row);
  if (error) {
    if (isMissingTable(error)) warnMissingOnce();
    // 幂等冲突(唯一键):同一笔影子成交已执行过,静默忽略
    else if (!/duplicate key|unique/i.test(error.message)) {
      console.warn(`[accounts] 执行单落库失败: ${error.message}`);
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

async function doExecute(account, trade) {
  const broker = clientFor(account);
  const symbol = trade.symbol;
  const side = trade.side;
  const internalPrice = Number(trade.price);
  let qty = Number(trade.quantity);
  const clientOrderId = `shadow-${trade.id}`;
  const base = {
    account_id: account.id,
    shadow_trade_id: trade.id,
    variant: trade.variant,
    symbol,
    side,
    client_order_id: clientOrderId,
    internal_price: internalPrice,
    extended_hours: getMarketSession() !== 'regular',
  };

  // 卖出:以券商侧真实持仓为准(两边账本会因部分成交/未成交而漂移)
  if (side === 'sell') {
    const pos = await broker.getPosition(symbol).catch(() => undefined);
    if (pos === undefined) throw new Error(`${symbol} 查询券商持仓失败`);
    qty = adjustSellQty({
      internalQty: qty,
      brokerQty: Number(pos?.qty_available ?? pos?.qty ?? 0),
    });
    if (!(qty > 0)) {
      await insertRow({ ...base, qty: 0, status: 'skipped', note: '券商账户无该持仓,跳过执行卖出' });
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
    const order = await broker.submitOrder({
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
      `[accounts] ${account.name}(${trade.variant}) 执行 ${side} ${symbol} ×${attemptQty} 限价 $${limitPrice}${base.extended_hours ? '(盘外)' : ''}`
    );
  };

  try {
    await attempt(qty);
  } catch (err) {
    // 幂等冲突:该影子成交已执行过(重试/并发),轮询循环会继续跟进既有订单
    if (err.status === 422 && /client_order_id/i.test(JSON.stringify(err.body || ''))) {
      const existing = await broker.getOrderByClientId(clientOrderId).catch(() => null);
      if (existing) return;
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
 * 影子成交执行入口(shadowPortfolio 成交后调用,fire-and-forget):
 * 找到指派给该变体的启用账户后异步执行;无指派/停用/缺表时零成本返回。
 * trade 须带 { id, variant, symbol, side, quantity, price }(id 缺失无法幂等,跳过)。
 */
export function onShadowTrade(trade) {
  if (!isAccountsAvailable() || !trade?.id || !trade.symbol || !trade.variant) return;
  const account = accounts.find((a) => a.enabled && a.purpose === trade.variant);
  if (!account) return;
  enqueue(`执行 ${trade.variant}/${trade.side} ${trade.symbol}`, () => doExecute(account, trade));
}

// ── 轮询与快照(scheduler 调用)──

let polling = false;
const lastSnapshotByAccount = new Map();
const SNAPSHOT_INTERVAL_MS = 10 * 60_000;

/** 该变体的最新影子净值(快照对照列);失败/无快照返回 null */
async function latestShadowValue(variant) {
  if (!variant) return null;
  try {
    const { data, error } = await supabase()
      .from('shadow_snapshots')
      .select('total_value')
      .eq('variant', variant)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error || !data?.length) return null;
    return Number(data[0].total_value);
  } catch {
    return null;
  }
}

/** 由调度器周期调用(60s):回填在途执行单的撮合结果 + 每账户限频净值快照 */
export async function pollBrokerAccountOrders() {
  if (!isAccountsAvailable() || polling) return;
  polling = true;
  try {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const { data: rows, error } = await supabase()
      .from('broker_account_orders')
      .select('id, account_id, side, internal_price, broker_order_id, client_order_id, status')
      .in('status', ['submitted', 'partially_filled'])
      .order('submitted_at', { ascending: true })
      .limit(50);
    if (error) {
      if (isMissingTable(error)) warnMissingOnce();
      else console.warn(`[accounts] 读取在途执行单失败: ${error.message}`);
      return;
    }
    let updated = 0;
    for (const row of rows || []) {
      const account = byId.get(row.account_id);
      if (!account) continue; // 账户已删除,级联清理会带走这些行
      const broker = clientFor(account);
      let order = null;
      try {
        order = row.broker_order_id
          ? await broker.getOrder(row.broker_order_id)
          : await broker.getOrderByClientId(row.client_order_id);
      } catch (err) {
        console.warn(`[accounts] 查询执行单 #${row.id} 失败: ${err.message}`);
        continue;
      }
      if (!order) {
        await supabase()
          .from('broker_account_orders')
          .update({ status: 'error', note: '券商侧未找到订单', updated_at: new Date().toISOString() })
          .eq('id', row.id);
        continue;
      }
      const patch = fillPatch(order, { side: row.side, internalPrice: row.internal_price });
      if (patch.status !== row.status || patch.filled_avg_price) {
        const { error: updErr } = await supabase().from('broker_account_orders').update(patch).eq('id', row.id);
        if (!updErr) updated += 1;
      }
    }

    // 每账户净值快照(10 分钟限频):已指派用途的启用账户 equity/cash + 同变体影子净值
    for (const account of accounts) {
      if (!account.enabled || !account.purpose) continue;
      const last = lastSnapshotByAccount.get(account.id) || 0;
      if (Date.now() - last < SNAPSHOT_INTERVAL_MS) continue;
      lastSnapshotByAccount.set(account.id, Date.now());
      try {
        const brokerAccount = await clientFor(account).getAccount();
        await supabase().from('broker_account_snapshots').insert({
          account_id: account.id,
          variant: account.purpose,
          equity: Number(brokerAccount.equity),
          cash: Number(brokerAccount.cash),
          shadow_total_value: await latestShadowValue(account.purpose),
        });
        if (account.status !== 'ok') {
          await supabase()
            .from('broker_accounts')
            .update({ status: 'ok', last_error: null, updated_at: new Date().toISOString() })
            .eq('id', account.id);
          account.status = 'ok';
        }
      } catch (err) {
        console.warn(`[accounts] ${account.name} 净值快照失败: ${err.message}`);
        await supabase()
          .from('broker_accounts')
          .update({
            status: 'error',
            last_error: String(err.message).slice(0, 200),
            updated_at: new Date().toISOString(),
          })
          .eq('id', account.id)
          .then(({ error: updErr }) => {
            if (!updErr) {
              account.status = 'error';
              account.last_error = String(err.message).slice(0, 200);
            }
          });
      }
    }
    if (updated) console.log(`[accounts] 执行单回填 ${updated} 条`);
  } finally {
    polling = false;
  }
}

/** 管理重置:各账户券商侧撤单+清仓,清空执行单/快照表(账户与用途指派保留),全部 best-effort */
export async function resetBrokerAccounts() {
  lastSnapshotByAccount.clear();
  for (const account of accounts) {
    if (!account.enabled) continue;
    const broker = clientFor(account);
    await broker.cancelOpenOrders().catch((err) =>
      console.warn(`[accounts] ${account.name} 重置撤单失败: ${err.message}`)
    );
    await broker.closeAllPositions().catch((err) =>
      console.warn(`[accounts] ${account.name} 重置清仓失败: ${err.message}`)
    );
  }
  for (const table of ['broker_account_orders', 'broker_account_snapshots']) {
    const { error } = await supabase().from(table).delete().gte('id', 0);
    if (error && !isMissingTable(error)) {
      console.warn(`[accounts] 清空 ${table} 失败: ${error.message}`);
    }
  }
}
