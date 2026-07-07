// 主账户交易策略运行时选择(024,取代 023 的 volBracket 布尔开关):
// 管理员页选择器切换,预设对应消融实验的各变体——出场规则类只改止损止盈/时限,
// 入场路径类(immediate_*/equal_weight)绕过候选池/LLM 决策/风控官(锁内硬风控永不绕过)。
// 上半部为纯函数(node:test 直接测),下半部为运行时状态(013/023 同款持久化模式)。
// 日志前缀 [strategy]。
import { supabase } from '../db.js';

export const STRATEGIES = [
  'default',
  'wide_bracket',
  'trailing_only',
  'vol_bracket',
  'immediate_trade',
  'immediate_rotation',
  'equal_weight',
];

/** 入场路径类策略:信号到达即确定性建仓,绕过候选池/LLM/风控官(分配器同时暂停) */
const ENTRY_PATH_STRATEGIES = new Set(['immediate_trade', 'immediate_rotation', 'equal_weight']);

export function isEntryPathStrategy(strategy) {
  return ENTRY_PATH_STRATEGIES.has(strategy);
}

/**
 * 纯函数:按策略给出买入 bracket(%)。trailing_only 的止盈为 null(离场只靠棘轮/时限);
 * vol_bracket 用波动缩放宽度,波动不可算(null)时回退固定值——与影子变体同语义。
 */
export function strategyBracket(strategy, { volBracketPercent = null, cfg } = {}) {
  switch (strategy) {
    case 'wide_bracket':
      return { stopLossPercent: cfg.shadowWideBracketPercent, takeProfitPercent: cfg.shadowWideBracketPercent };
    case 'trailing_only':
      return { stopLossPercent: cfg.stopLossPercent, takeProfitPercent: null };
    case 'vol_bracket':
      return volBracketPercent !== null && volBracketPercent !== undefined
        ? { stopLossPercent: volBracketPercent, takeProfitPercent: volBracketPercent }
        : { stopLossPercent: cfg.stopLossPercent, takeProfitPercent: cfg.takeProfitPercent };
    default:
      // default / immediate_trade / immediate_rotation / equal_weight → 固定 ±N%
      return { stopLossPercent: cfg.stopLossPercent, takeProfitPercent: cfg.takeProfitPercent };
  }
}

/** 纯函数:按策略给出持有时限(小时)。wide_bracket 96h,其余沿用全局 */
export function strategyMaxHoldHours(strategy, cfg) {
  return cfg.strategyMaxHoldHours?.[strategy] ?? cfg.maxHoldHours;
}

// ── 运行时状态(portfolio_state.trading_strategy,管理页切换,重启保持)──

let current = 'default';
let columnMissing = false;

function isMissingColumn(error) {
  return (
    /trading_strategy/.test(error?.message || '') && /column|schema/i.test(error?.message || '')
  );
}

/** 当前策略(同步读内存缓存,交易路径零开销) */
export function getTradingStrategy() {
  return current;
}

/** 波动自适应敞口是否生效(= 策略为 vol_bracket;保留旧名,消费方无感切换) */
export function isVolBracketEnabled() {
  return current === 'vol_bracket';
}

/** 服务启动时从库中加载;无 Supabase 配置/缺列/未知值时保持 'default',绝不抛错 */
export async function loadTradingStrategy() {
  try {
    const { data, error } = await supabase()
      .from('portfolio_state')
      .select('trading_strategy')
      .eq('id', 1)
      .maybeSingle();
    if (error) {
      if (isMissingColumn(error)) {
        columnMissing = true;
        console.warn('[strategy] portfolio_state 缺少 trading_strategy 列,策略选择器停用(请执行 024 迁移)');
      } else {
        console.warn(`[strategy] 加载交易策略失败: ${error.message}`);
      }
      return;
    }
    const value = data?.trading_strategy;
    if (value && STRATEGIES.includes(value)) {
      current = value;
      if (value !== 'default') console.log(`[strategy] 主账户交易策略: ${value}`);
    } else if (value) {
      console.warn(`[strategy] 库中策略值未知(${value}),按 default 处理`);
    }
  } catch (err) {
    if (!/Supabase 未配置/.test(err.message)) {
      console.warn(`[strategy] 加载交易策略失败: ${err.message}`);
    }
  }
}

/**
 * 切换策略。切回 default 走"先内存后库"(fail-safe 方向,立即回到最保守的默认链路);
 * 切到其它策略走"先库后内存"(行为开关静默回退会污染证据解读,023 同款权衡)。
 * 非法预设 400,缺列 409。返回 { strategy, persisted }。
 */
export async function setTradingStrategy(strategy) {
  if (!STRATEGIES.includes(strategy)) {
    const err = new Error(`未知策略 ${strategy},可选: ${STRATEGIES.join(' / ')}`);
    err.status = 400;
    throw err;
  }
  if (strategy === 'default') {
    current = 'default';
    try {
      const { error } = await supabase()
        .from('portfolio_state')
        .update({ trading_strategy: 'default', updated_at: new Date().toISOString() })
        .eq('id', 1);
      if (error) throw new Error(error.message);
      return { strategy, persisted: true };
    } catch (err) {
      console.warn(`[strategy] 持久化交易策略失败: ${err.message}`);
      return { strategy, persisted: false };
    }
  }
  const { error } = await supabase()
    .from('portfolio_state')
    .update({ trading_strategy: strategy, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) {
    if (isMissingColumn(error)) {
      columnMissing = true;
      const err = new Error('portfolio_state 缺少 trading_strategy 列,请执行 024 迁移');
      err.status = 409;
      throw err;
    }
    const err = new Error(`持久化交易策略失败: ${error.message}`);
    err.status = 500;
    throw err;
  }
  current = strategy;
  console.log(`[strategy] 主账户交易策略已切换(管理员): ${strategy}`);
  return { strategy, persisted: true };
}
