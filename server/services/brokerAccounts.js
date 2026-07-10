// 多券商模拟账户(025,log 前缀 [broker]):broker_accounts 表存账户凭据与用途,
// 管理页 CRUD。每个账户的 purpose 决定它镜像谁:
//   mirror_actual   实盘成交镜像(与 env 默认账户同义,可多个并行)
//   <影子变体名>     该消融变体的影子买卖以 marketable 限价单镜像到该账户(真实 NBBO 撮合)
//   unassigned      闲置
// 安全约定:secret_key 永不出服务端(列表接口只回传脱敏 key_id);表 RLS 开启且
// 无公开读策略;凭据仅在服务端换取券商请求头。表缺失(025 未迁移)→ 功能停用,
// 管理端点 409;进程内缓存供镜像热路径同步读取,CRUD 后即时刷新。
import { supabase } from '../db.js';
import { config } from '../config.js';
import { getAccount, isBrokerEnabled } from './alpacaBroker.js';
import { SHADOW_VARIANTS } from './shadowPortfolio.js';

let accounts = [];
let tableMissing = false;
let loaded = false;

function isMissingTable(error) {
  return (
    error?.code === 'PGRST205' ||
    (/broker_accounts/.test(error?.message || '') &&
      /not find|does not exist|schema cache/i.test(error?.message || ''))
  );
}

/** 合法用途:实盘镜像 / 闲置 / 任一可交易影子变体(基准与纯现金无交易可镜像) */
export function validPurposes() {
  return [
    'mirror_actual',
    'unassigned',
    ...SHADOW_VARIANTS.filter((v) => v !== 'spy_benchmark' && v !== 'cash'),
  ];
}

function requireTable() {
  if (tableMissing) {
    const err = new Error('broker_accounts 表不可用,请执行 025 迁移');
    err.status = 409;
    throw err;
  }
}

/** 启动/CRUD 后加载账户缓存;缺表警告一次后停用,绝不抛错 */
export async function loadBrokerAccounts() {
  try {
    const { data, error } = await supabase()
      .from('broker_accounts')
      .select('*')
      .order('id', { ascending: true });
    if (error) {
      if (isMissingTable(error)) {
        if (!tableMissing) console.warn('[broker] broker_accounts 表不可用,多账户功能停用(请执行 025 迁移)');
        tableMissing = true;
      } else {
        console.warn(`[broker] 加载券商账户失败: ${error.message}`);
      }
      return;
    }
    tableMissing = false;
    accounts = data || [];
    loaded = true;
    if (accounts.length) console.log(`[broker] 已加载 ${accounts.length} 个券商模拟账户`);
  } catch (err) {
    if (!/Supabase 未配置/.test(err.message)) {
      console.warn(`[broker] 加载券商账户失败: ${err.message}`);
    }
  }
}

/** 指定用途的启用账户(同步读缓存,镜像热路径用) */
export function accountsForPurpose(purpose) {
  return accounts.filter((a) => a.enabled && a.purpose === purpose);
}

/** 全部启用账户(轮询/重置用) */
export function enabledAccounts() {
  return accounts.filter((a) => a.enabled);
}

/** 按 id 取账户凭据(轮询回填历史单用;含已停用账户) */
export function accountById(id) {
  return accounts.find((a) => a.id === id) || null;
}

/** 账户行 → 券商客户端凭据 */
export function credsOf(account) {
  return account ? { keyId: account.key_id, secretKey: account.secret_key } : null;
}

/** 脱敏列表(管理页):key_id 只留前 4 位,secret 永不回传 */
export function listAccountsMasked() {
  requireTable();
  return accounts.map((a) => ({
    id: a.id,
    label: a.label,
    key_id_masked: `${String(a.key_id).slice(0, 4)}****`,
    purpose: a.purpose,
    enabled: a.enabled,
    created_at: a.created_at,
  }));
}

/**
 * 新增账户:先用凭据调一次券商账户接口校验(无效凭据 400),再落库并刷新缓存。
 * 唯一性防线:同一物理账户被多路镜像流并发写会现金混账、对账互搏 —— key_id 与
 * env 默认账户/既有账户精确重复直接拒;再用校验回包的 account_number 与各账户
 * 比对(同一账户可签发多把 key,key_id 不同也可能是同一账户;比对 best-effort,
 * 单个账户读数失败只跳过该项,不阻断添加)。
 */
export async function addBrokerAccount({ label, keyId, secretKey, purpose = 'unassigned' }) {
  requireTable();
  if (!label || !keyId || !secretKey) {
    const err = new Error('label / keyId / secretKey 均为必填');
    err.status = 400;
    throw err;
  }
  if (!validPurposes().includes(purpose)) {
    const err = new Error(`未知用途 ${purpose},可选: ${validPurposes().join(' / ')}`);
    err.status = 400;
    throw err;
  }
  if (keyId === config.alpacaKeyId || accounts.some((a) => a.key_id === keyId)) {
    const err = new Error('该 key_id 已被使用(与 env 默认账户或既有账户重复):同一物理账户不可绑定多路镜像流');
    err.status = 400;
    throw err;
  }
  let newAccountNumber = null;
  try {
    const acc = await getAccount({ keyId, secretKey });
    newAccountNumber = acc?.account_number || null;
  } catch (err) {
    const e = new Error(`券商凭据校验失败: ${err.message}`);
    e.status = 400;
    throw e;
  }
  if (newAccountNumber) {
    const peers = [
      ...(isBrokerEnabled() ? [{ label: 'env 默认账户', creds: null }] : []),
      ...accounts.filter((a) => a.enabled).map((a) => ({ label: a.label, creds: credsOf(a) })),
    ];
    const numbers = await Promise.all(
      peers.map((p) => getAccount(p.creds).then((a) => a?.account_number || null).catch(() => null))
    );
    const clash = peers[numbers.findIndex((n) => n && n === newAccountNumber)];
    if (clash) {
      const err = new Error(`该凭据指向的券商账户与「${clash.label}」是同一物理账户,不可重复绑定`);
      err.status = 400;
      throw err;
    }
  }
  const { data, error } = await supabase()
    .from('broker_accounts')
    .insert({ label: String(label).slice(0, 100), key_id: keyId, secret_key: secretKey, purpose })
    .select('id')
    .single();
  if (error) {
    if (isMissingTable(error)) {
      tableMissing = true;
      requireTable();
    }
    const e = new Error(`账户保存失败: ${error.message}`);
    e.status = 500;
    throw e;
  }
  await loadBrokerAccounts();
  console.log(`[broker] 新增券商模拟账户 #${data.id}(${label},用途 ${purpose})`);
  return { id: data.id };
}

/**
 * 更新账户(label/purpose/enabled;凭据不可改,重配请删除重加)。
 * purpose 变更时该账户的 deferred 顺延单一并作废(旧用途的顺延买卖提交出去
 * 只会制造与新对账基准的分歧,再被对账清理平掉——白绕一圈);已提交在途单
 * 保持轮询到终局。账户随后由对账清理向新用途的基准账本收敛。
 */
export async function updateBrokerAccount(id, { label, purpose, enabled } = {}) {
  requireTable();
  const before = accountById(Number(id));
  const patch = { updated_at: new Date().toISOString() };
  if (label !== undefined) patch.label = String(label).slice(0, 100);
  if (purpose !== undefined) {
    if (!validPurposes().includes(purpose)) {
      const err = new Error(`未知用途 ${purpose},可选: ${validPurposes().join(' / ')}`);
      err.status = 400;
      throw err;
    }
    patch.purpose = purpose;
  }
  if (enabled !== undefined) patch.enabled = Boolean(enabled);
  const { data, error } = await supabase()
    .from('broker_accounts')
    .update(patch)
    .eq('id', id)
    .select('id');
  if (error) {
    const e = new Error(`账户更新失败: ${error.message}`);
    e.status = 500;
    throw e;
  }
  if (!data?.length) {
    const e = new Error(`账户 #${id} 不存在`);
    e.status = 404;
    throw e;
  }
  if (purpose !== undefined && before && before.purpose !== purpose) {
    const { error: defErr } = await supabase()
      .from('broker_mirror_orders')
      .update({ status: 'abandoned', note: '账户用途变更,顺延单作废', updated_at: new Date().toISOString() })
      .eq('account_id', id)
      .eq('status', 'deferred');
    if (defErr && !/broker_mirror|account_id/.test(defErr.message)) {
      console.warn(`[broker] 账户 #${id} 用途变更作废顺延单失败: ${defErr.message}`);
    }
  }
  await loadBrokerAccounts();
  console.log(`[broker] 券商模拟账户 #${id} 已更新`);
  return { id: Number(id) };
}

/**
 * 删除账户:先删该账户的对照单与快照,再删账户行。
 * 不能依赖外键 on delete set null 保留历史 —— account_id 置空后这些行会被当成
 * env 默认账户的数据(轮询拿 env 凭据处理别人的单、deferred 单会提交进 env 账户、
 * 净值曲线与盈亏基线被污染)。券商侧持仓/挂单不动:删除的是绑定关系,不是账户本身。
 */
export async function deleteBrokerAccount(id) {
  requireTable();
  for (const table of ['broker_mirror_orders', 'broker_mirror_snapshots']) {
    const { error } = await supabase().from(table).delete().eq('account_id', id);
    // 021 表未建/025 列缺失 = 无可污染,忽略;其余失败中止删除,防止遗留行归并进 env 账户
    if (error && !/account_id|not find|does not exist|schema cache/i.test(error.message)) {
      const e = new Error(`清理账户 #${id} 的 ${table} 失败,中止删除: ${error.message}`);
      e.status = 500;
      throw e;
    }
  }
  const { error } = await supabase().from('broker_accounts').delete().eq('id', id);
  if (error) {
    const e = new Error(`账户删除失败: ${error.message}`);
    e.status = 500;
    throw e;
  }
  await loadBrokerAccounts();
  console.log(`[broker] 券商模拟账户 #${id} 已删除(对照单/快照一并清理)`);
  return { id: Number(id) };
}
