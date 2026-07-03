import { supabase } from '../db.js';

/**
 * 波动自适应敞口运行时开关(023):管理员页切换,持久化在 portfolio_state.vol_bracket_enabled。
 * 与 tradingHalt(013)同为运行时开关,但写序刻意相反:
 * - 开启:先写库、成功才翻内存——行为开关若仅内存生效、重启静默回退,会污染
 *   实盘与 vol_bracket 影子变体的证据解读(哪段时间实盘在用哪种 bracket 说不清);
 * - 关闭:先翻内存(fail-safe 方向,立即回到保守的固定 ±2%)再 best-effort 持久化。
 * 023 未迁移(缺列):开关视为 false,setVolBracketEnabled(true) 抛 409 提示执行迁移。
 */

let enabled = false;
let columnMissing = false;

function isMissingColumn(error) {
  return (
    /vol_bracket_enabled/.test(error?.message || '') && /column|schema/i.test(error?.message || '')
  );
}

/** 当前是否启用波动自适应 bracket(同步读内存缓存,交易路径零开销) */
export function isVolBracketEnabled() {
  return enabled;
}

/** 服务启动时从库中加载开关状态;无 Supabase 配置/缺列/无行时保持 false,绝不抛错 */
export async function loadVolBracket() {
  try {
    const { data, error } = await supabase()
      .from('portfolio_state')
      .select('vol_bracket_enabled')
      .eq('id', 1)
      .maybeSingle();
    if (error) {
      if (isMissingColumn(error)) {
        columnMissing = true;
        console.warn('[risk] portfolio_state 缺少 vol_bracket_enabled 列,波动敞口开关停用(请执行 023 迁移)');
      } else {
        console.warn(`[risk] 加载波动敞口开关失败: ${error.message}`);
      }
      return;
    }
    enabled = data?.vol_bracket_enabled === true;
    if (enabled) console.log('[risk] 波动自适应敞口处于开启状态,买入 bracket 按 20 日波动缩放');
  } catch (err) {
    if (!/Supabase 未配置/.test(err.message)) {
      console.warn(`[risk] 加载波动敞口开关失败: ${err.message}`);
    }
  }
}

/** 设置开关。开启走"先库后内存",关闭走"先内存后库";返回 { enabled, persisted } */
export async function setVolBracketEnabled(value) {
  const next = Boolean(value);
  if (!next) {
    // 关闭:fail-safe 方向,立即生效
    enabled = false;
    try {
      const { error } = await supabase()
        .from('portfolio_state')
        .update({ vol_bracket_enabled: false, updated_at: new Date().toISOString() })
        .eq('id', 1);
      if (error) throw new Error(error.message);
      return { enabled: false, persisted: true };
    } catch (err) {
      console.warn(`[risk] 持久化波动敞口开关失败: ${err.message}`);
      return { enabled: false, persisted: false };
    }
  }
  // 开启:先写库,成功才翻内存(重启静默回退会污染证据解读)
  const { error } = await supabase()
    .from('portfolio_state')
    .update({ vol_bracket_enabled: true, updated_at: new Date().toISOString() })
    .eq('id', 1);
  if (error) {
    if (isMissingColumn(error)) {
      columnMissing = true;
      const err = new Error('portfolio_state 缺少 vol_bracket_enabled 列,请执行 023 迁移');
      err.status = 409;
      throw err;
    }
    const err = new Error(`持久化波动敞口开关失败: ${error.message}`);
    err.status = 500;
    throw err;
  }
  enabled = true;
  console.log('[risk] 波动自适应敞口已开启(管理员),买入 bracket 按 20 日波动缩放');
  return { enabled: true, persisted: true };
}
