import { supabase } from '../db.js';
import { config } from '../config.js';
import { cycleStatus } from './newsService.js';
import { withTradeLock } from './trader.js';
import { clearCaches } from './fmp.js';
import { getValuation } from './portfolio.js';
import { broadcast } from './bus.js';
import { isHalted, setHalted } from './halt.js';

/** admin_reset_data RPC 尚未部署(未执行 005 迁移)时的判定 */
function isMissingResetRpc(error) {
  return error?.code === 'PGRST202' || /admin_reset_data/.test(error?.message || '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等待运行中的交易轮结束(最多 maxWaitMs),保证重置不与抓取/分析/交易并发 */
async function drainRunningCycle(maxWaitMs = 60_000) {
  const start = Date.now();
  while (cycleStatus.running) {
    if (Date.now() - start > maxWaitMs) return false;
    await sleep(500);
  }
  return true;
}

/**
 * 回退路径:数据库尚未部署 admin_reset_data RPC 时,逐表删除。
 * 删除顺序遵循外键依赖:先删引用方,再删被引用方。
 */
async function legacyReset(db) {
  const steps = [
    // trade_reflections 引用 trades(006 迁移新增,缺表时容忍)
    { table: 'trade_reflections', filter: (q) => q.neq('id', 0), optional: true },
    { table: 'trades', filter: (q) => q.neq('id', 0) },
    { table: 'news_events', filter: (q) => q.neq('id', 0) },
    { table: 'news_analyses', filter: (q) => q.neq('id', 0) },
    { table: 'news_articles', filter: (q) => q.neq('id', 0) },
    { table: 'portfolio_snapshots', filter: (q) => q.neq('id', 0) },
    { table: 'positions', filter: (q) => q.neq('symbol', '') },
  ];
  for (const step of steps) {
    const { error } = await step.filter(db.from(step.table).delete());
    if (error) {
      if (step.optional && /does not exist|not find/i.test(error.message)) continue;
      throw new Error(`清空 ${step.table} 失败: ${error.message}`);
    }
  }
  const { error: stateErr } = await db
    .from('portfolio_state')
    .update({
      cash: config.initialCapital,
      initial_capital: config.initialCapital,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);
  if (stateErr) throw new Error(`重置资金账户失败: ${stateErr.message}`);
}

/**
 * 全量数据初始化:清空新闻/分析/事件/交易/持仓/快照,现金恢复到初始资金。
 * 流程:暂停调度 → 等运行中的交易轮排空 → 在交易锁内清库 → 清进程内缓存 → 恢复调度。
 */
export async function resetAllData() {
  if (isHalted()) {
    const err = new Error('已有一个重置操作在进行中');
    err.status = 409;
    throw err;
  }
  setHalted(true);
  console.log('[admin] 开始全量数据重置,已暂停调度');

  try {
    const drained = await drainRunningCycle();
    if (!drained) {
      const err = new Error('当前有交易轮长时间未结束,重置已取消,请稍后重试');
      err.status = 409;
      throw err;
    }

    await withTradeLock(async () => {
      const db = supabase();
      const { error } = await db.rpc('admin_reset_data', {
        p_initial_capital: config.initialCapital,
      });
      if (!error) return;
      if (!isMissingResetRpc(error)) throw new Error(`重置失败: ${error.message}`);
      console.warn('[admin] admin_reset_data RPC 不可用,退回逐表删除(请尽快执行 005 迁移)');
      await legacyReset(db);
    });

    // 清进程内状态:报价/档案缓存与上一轮结果都已对应被删除的数据
    clearCaches();
    cycleStatus.lastResult = null;
    cycleStatus.lastError = null;
    cycleStatus.lastRunAt = null;

    console.log('[admin] 全量数据重置完成,现金已恢复为 $' + config.initialCapital);
  } finally {
    setHalted(false);
  }

  const resetAt = new Date().toISOString();
  broadcast('reset', { at: resetAt });
  try {
    broadcast('portfolio', await getValuation());
  } catch (err) {
    console.warn(`[admin] 重置后推送组合估值失败: ${err.message}`);
  }
  return { ok: true, reset_at: resetAt, initial_capital: config.initialCapital };
}
