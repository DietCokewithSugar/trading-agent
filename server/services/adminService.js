import { supabase } from '../db.js';
import { config } from '../config.js';
import { cycleStatus } from './newsService.js';
import { allocatorStatus } from './allocator.js';
import { queueStatus } from './openQueue.js';
import { withTradeLock } from './trader.js';
import { clearCaches } from './fmp.js';
import { getValuation } from './portfolio.js';
import { broadcast } from './bus.js';
import { isHalted, setHalted } from './halt.js';
import { resetMetrics } from './metrics.js';
import { resetRiskControlState } from './riskControls.js';
import { resetRegimeState } from './macroRegime.js';
import { resetShadowState, initShadowPortfolios, drainShadowQueue } from './shadowPortfolio.js';
import { resetBrokerMirror } from './brokerMirror.js';

/** admin_reset_data RPC 尚未部署(未执行 005 迁移)时的判定 */
function isMissingResetRpc(error) {
  return error?.code === 'PGRST202' || /admin_reset_data/.test(error?.message || '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等待运行中的交易轮/资金分配轮/开盘队列批次结束(最多 maxWaitMs),
 *  保证重置不与抓取/分析/交易并发。开盘队列必须纳入:在途买单若在截库后才拿到
 *  交易锁,会对着刚恢复初始资金的干净账本成交(止损/复查只做卖出,截库后无持仓
 *  自然落空,无需等待) */
async function drainRunningCycle(maxWaitMs = 60_000) {
  const start = Date.now();
  while (cycleStatus.running || allocatorStatus.running || queueStatus.running) {
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
    // trade_reflections / pending_orders 引用 trades(006/010 迁移新增,缺表时容忍)
    { table: 'trade_reflections', filter: (q) => q.neq('id', 0), optional: true },
    { table: 'pending_orders', filter: (q) => q.neq('id', 0), optional: true },
    // cycle_runs 主键是 uuid(012 迁移新增,缺表时容忍),无自增 id 可比,按非空主键全删
    { table: 'cycle_runs', filter: (q) => q.not('run_id', 'is', null), optional: true },
    // 候选池 / 宏观事件(014 迁移新增,缺表时容忍);candidate_signals 引用 trades,先删
    { table: 'candidate_signals', filter: (q) => q.neq('id', 0), optional: true },
    { table: 'macro_events', filter: (q) => q.neq('id', 0), optional: true },
    // 决策回放(018 迁移新增,缺表时容忍);引用 trades/news,先删
    { table: 'trade_decisions', filter: (q) => q.neq('id', 0), optional: true },
    // 影子组合(017 迁移新增,缺表时容忍);positions 引用 portfolios,先删
    { table: 'shadow_trades', filter: (q) => q.neq('id', 0), optional: true },
    { table: 'shadow_snapshots', filter: (q) => q.neq('id', 0), optional: true },
    { table: 'shadow_positions', filter: (q) => q.neq('symbol', ''), optional: true },
    { table: 'shadow_portfolios', filter: (q) => q.neq('variant', ''), optional: true },
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
  await resetMacroStateRow(db);
}

/** 宏观状态复位为 neutral(014 迁移新增,缺表时容忍,失败仅告警) */
async function resetMacroStateRow(db) {
  const { error } = await db
    .from('macro_state')
    .update({
      regime: 'neutral',
      risk_score: 0,
      rates_signal: null,
      inflation_signal: null,
      growth_signal: null,
      shock_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);
  if (error && !/does not exist|not find|schema cache/i.test(error.message)) {
    console.warn(`[admin] 复位 macro_state 失败(可忽略): ${error.message}`);
  }
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
    // 排空影子组合串行链:已入队的影子改账在截库前执行完,halt 旗标挡住新任务,
    // 否则截库+重建之后才执行的幻影成交会写进全新影子账本
    await drainShadowQueue();

    await withTradeLock(async () => {
      const db = supabase();
      const { error } = await db.rpc('admin_reset_data', {
        p_initial_capital: config.initialCapital,
      });
      if (!error) {
        // 数据库里可能还是 005/012 版函数(truncate 列表不含后续新表),补一次 best-effort 清理;
        // 014/017 版函数已清过,这里删空表无副作用,缺表/失败仅告警
        const cleanups = [
          ['cycle_runs', (q) => q.not('run_id', 'is', null)],
          ['candidate_signals', (q) => q.neq('id', 0)],
          ['macro_events', (q) => q.neq('id', 0)],
          ['trade_decisions', (q) => q.neq('id', 0)],
          ['shadow_trades', (q) => q.neq('id', 0)],
          ['shadow_snapshots', (q) => q.neq('id', 0)],
          ['shadow_positions', (q) => q.neq('symbol', '')],
          ['shadow_portfolios', (q) => q.neq('variant', '')],
        ];
        for (const [table, filter] of cleanups) {
          const { error: cleanErr } = await filter(db.from(table).delete());
          if (cleanErr && !/does not exist|not find|schema cache/i.test(cleanErr.message)) {
            console.warn(`[admin] 清空 ${table} 失败(可忽略): ${cleanErr.message}`);
          }
        }
        await resetMacroStateRow(db);
        return;
      }
      if (!isMissingResetRpc(error)) throw new Error(`重置失败: ${error.message}`);
      console.warn('[admin] admin_reset_data RPC 不可用,退回逐表删除(请尽快执行 005 迁移)');
      await legacyReset(db);
    });

    // 清进程内状态:报价/档案缓存、运行指标与上一轮结果都已对应被删除的数据。
    // 注意:人工交易暂停开关(tradingHalt)不随重置改变——人工开关由人工关;
    // 经济日历缓存也不清——它是外部市场数据,清空只会在下次轮询前误报「日历不可用」
    clearCaches();
    resetMetrics();
    resetRiskControlState();
    resetRegimeState();
    cycleStatus.lastResult = null;
    cycleStatus.lastError = null;
    cycleStatus.lastRunAt = null;

    // 影子组合:清进程内状态并重建各变体资金行(消融实验从零重新积累;失败仅告警)
    if (config.enableShadow) {
      resetShadowState();
      await initShadowPortfolios().catch((err) =>
        console.warn(`[admin] 影子组合重建失败(可忽略): ${err.message}`)
      );
    }

    // 券商模拟对照账本(021):券商侧撤单+清仓,本地对照表清空(全部 best-effort)
    await resetBrokerMirror().catch((err) =>
      console.warn(`[admin] 券商对照账本重置失败(可忽略): ${err.message}`)
    );

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
