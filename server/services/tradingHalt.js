import { supabase } from '../db.js';

/**
 * 人工交易暂停开关(kill switch,013 迁移):管理员一键暂停开新仓。
 * 只拦新开买入(新闻买入 + 开盘队列买单),所有卖出(新闻/止损/止盈/复查)不受影响——
 * 暂停开关绝不能禁用保护性退出。
 * 与 halt.js 的区别:halt.js 是管理重置期间的全局调度暂停(短暂的系统操作),
 * 本开关是管理员的人工风控决策,持久化在 portfolio_state.trading_halted,跨重启保留。
 * 013 未执行时降级为仅内存生效(告警一次),重启后状态丢失。
 */

let halted = false;
let columnMissing = false;

function isMissingColumn(error) {
  return (
    /trading_halted/.test(error?.message || '') && /column|schema/i.test(error?.message || '')
  );
}

function warnMissingOnce() {
  if (columnMissing) return;
  columnMissing = true;
  console.warn('[risk] portfolio_state 缺少 trading_halted 列,暂停开关仅内存生效(请执行 013 迁移)');
}

/** 当前是否人工暂停开新仓(同步读内存缓存,交易路径零开销) */
export function isTradingHalted() {
  return halted;
}

/** 服务启动时从库中加载开关状态;无 Supabase 配置/缺列/无行时保持 false,绝不抛错 */
export async function loadTradingHalt() {
  try {
    const { data, error } = await supabase()
      .from('portfolio_state')
      .select('trading_halted')
      .eq('id', 1)
      .maybeSingle();
    if (error) {
      if (isMissingColumn(error)) warnMissingOnce();
      else console.warn(`[risk] 加载交易暂停开关失败: ${error.message}`);
      return;
    }
    halted = data?.trading_halted === true;
    if (halted) console.warn('[risk] 交易暂停开关处于开启状态(人工),新开买入将被拦截');
  } catch (err) {
    // 无 Supabase 配置等:静默保持 false,服务照常启动
    if (!/Supabase 未配置/.test(err.message)) {
      console.warn(`[risk] 加载交易暂停开关失败: ${err.message}`);
    }
  }
}

/** 设置开关:先写内存(立即生效),再 best-effort 持久化。返回 { halted, persisted } */
export async function setTradingHalt(value) {
  halted = Boolean(value);
  if (columnMissing) return { halted, persisted: false };
  try {
    const { error } = await supabase()
      .from('portfolio_state')
      .update({ trading_halted: halted, updated_at: new Date().toISOString() })
      .eq('id', 1);
    if (error) {
      if (isMissingColumn(error)) warnMissingOnce();
      else console.warn(`[risk] 持久化交易暂停开关失败: ${error.message}`);
      return { halted, persisted: false };
    }
    return { halted, persisted: true };
  } catch (err) {
    console.warn(`[risk] 持久化交易暂停开关失败: ${err.message}`);
    return { halted, persisted: false };
  }
}
