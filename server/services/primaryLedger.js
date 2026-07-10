// 展示主账本切换(024):开启后仪表盘主视图(净值/持仓/净值曲线)的数据源切换为
// 券商模拟账户的真实数据;内部引擎账本与交易链路完全不变(决策/风控/绩效统计仍走内部账本)。
// 服务端单点切换:/api/portfolio、SSE portfolio/snapshot 广播、/api/snapshots、重置重广播
// 全部经 getPrimaryValuation()/相关辅助走同一开关,前端与 60s 兜底轮询自动一致。
// 券商取数失败 fail-open 回退内部账本(限频告警),仪表盘永不因外部 API 故障空白。
import { supabase } from '../db.js';
import { getValuation } from './portfolio.js';
import { getBrokerValuation, hasBrokerReference } from './brokerMirror.js';

let brokerPrimary = false;
let columnMissing = false;
let lastFailWarnAt = 0;

function isMissingColumn(error) {
  return (
    /broker_ledger_primary/.test(error?.message || '') && /column|schema/i.test(error?.message || '')
  );
}

/** 当前展示主账本是否为券商模拟账户(同步读内存缓存) */
export function isBrokerLedgerPrimary() {
  return brokerPrimary;
}

/** 服务启动时从库中加载;无 Supabase 配置/缺列时保持内部账本,绝不抛错 */
export async function loadPrimaryLedger() {
  try {
    const { data, error } = await supabase()
      .from('portfolio_state')
      .select('broker_ledger_primary')
      .eq('id', 1)
      .maybeSingle();
    if (error) {
      if (isMissingColumn(error)) {
        columnMissing = true;
        console.warn('[broker] portfolio_state 缺少 broker_ledger_primary 列,主账本切换停用(请执行 024 迁移)');
      } else {
        console.warn(`[broker] 加载主账本开关失败: ${error.message}`);
      }
      return;
    }
    // 参照账户 = 管理页主对照账户(029)或 env 默认账户;须在 loadBrokerAccounts 之后调用
    brokerPrimary = data?.broker_ledger_primary === true && hasBrokerReference();
    if (data?.broker_ledger_primary === true && !hasBrokerReference()) {
      console.warn('[broker] 主账本开关持久化为券商模拟,但无可用参照账户(env 未配置且未指定主对照账户),回退内部账本');
    }
    if (brokerPrimary) console.log('[broker] 展示主账本: 券商模拟账户');
  } catch (err) {
    if (!/Supabase 未配置/.test(err.message)) {
      console.warn(`[broker] 加载主账本开关失败: ${err.message}`);
    }
  }
}

/** 切换主账本。开启先写库(缺列 409、未配置券商 409),关闭先翻内存(fail-safe) */
export async function setBrokerLedgerPrimary(value) {
  const next = Boolean(value);
  if (!next) {
    brokerPrimary = false;
    try {
      const { error } = await supabase()
        .from('portfolio_state')
        .update({ broker_ledger_primary: false, updated_at: new Date().toISOString() })
        .eq('id', 1);
      if (error) throw new Error(error.message);
      return { enabled: false, persisted: true };
    } catch (err) {
      console.warn(`[broker] 持久化主账本开关失败: ${err.message}`);
      return { enabled: false, persisted: false };
    }
  }
  if (!hasBrokerReference()) {
    const err = new Error('无可用参照账户(env 未配置且未在管理页指定主对照账户),无法设为主账本');
    err.status = 409;
    throw err;
  }
  const { error } = await supabase()
    .from('portfolio_state')
    .update({ broker_ledger_primary: true, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) {
    if (isMissingColumn(error)) {
      columnMissing = true;
      const err = new Error('portfolio_state 缺少 broker_ledger_primary 列,请执行 024 迁移');
      err.status = 409;
      throw err;
    }
    const err = new Error(`持久化主账本开关失败: ${error.message}`);
    err.status = 500;
    throw err;
  }
  brokerPrimary = true;
  console.log('[broker] 展示主账本已切换为券商模拟账户(管理员)');
  return { enabled: true, persisted: true };
}

/**
 * 主视图估值:开关关 → 内部账本 getValuation(带 ledger 标记);
 * 开 → 券商模拟账户估值,取数失败回退内部账本(≤1 次/5 分钟告警)。
 */
export async function getPrimaryValuation(opts) {
  if (!brokerPrimary) {
    const v = await getValuation(opts);
    return { ...v, ledger: 'internal' };
  }
  try {
    return await getBrokerValuation();
  } catch (err) {
    if (Date.now() - lastFailWarnAt > 5 * 60_000) {
      lastFailWarnAt = Date.now();
      console.warn(`[broker] 券商模拟账户取数失败,主视图回退内部账本: ${err.message}`);
    }
    const v = await getValuation(opts);
    return { ...v, ledger: 'internal' };
  }
}
