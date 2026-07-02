/**
 * 持仓时限与止盈刷新的纯函数(020):
 * 持有期限 = hold_refreshed_at(缺失回退 opened_at)+ maxHoldHours,到期强制平仓;
 * 同票新利好事件刷新时钟并按 takeProfitStepPercent 上抬止盈线。
 * 无 IO、无副作用,便于单测(沿 sizing.js / eligibility.js 先例)。
 */

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/** 持有时钟锚点:优先刷新时间,回退建仓时间;两者皆缺(未执行 020 迁移的老库)返回 null */
export function holdAnchor(pos) {
  const raw = pos?.hold_refreshed_at ?? pos?.opened_at ?? null;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * 持仓是否已超过最长持有时限。
 * maxHoldHours <= 0(功能关闭)或锚点缺失(020 列不可用)一律返回 false —— 缺列时自动停用,
 * 绝不因迁移未执行而误平仓。
 */
export function isHoldExpired(pos, { maxHoldHours, now = new Date() } = {}) {
  if (!(maxHoldHours > 0)) return false;
  const anchor = holdAnchor(pos);
  if (anchor === null) return false;
  return now.getTime() - anchor > maxHoldHours * 3600_000;
}

/**
 * 同票新利好刷新时的止盈上抬:现止盈价 + avgCost × stepPercent/100(逐事件累加)。
 * 止盈为空(历史数据)时按 avgCost × (1 + (defaultTakeProfitPercent + stepPercent)/100) 初始化。
 * 入参非法(avgCost 缺失/step<=0)返回原值不动。
 */
export function bumpTakeProfit({ takeProfit, avgCost, stepPercent, defaultTakeProfitPercent } = {}) {
  const cost = Number(avgCost);
  const step = Number(stepPercent);
  if (!(cost > 0) || !(step > 0)) return takeProfit ?? null;
  const current = Number(takeProfit);
  if (Number.isFinite(current) && current > 0) {
    return round4(current + (cost * step) / 100);
  }
  const basePercent = Number(defaultTakeProfitPercent) > 0 ? Number(defaultTakeProfitPercent) : 0;
  return round4(cost * (1 + (basePercent + step) / 100));
}
