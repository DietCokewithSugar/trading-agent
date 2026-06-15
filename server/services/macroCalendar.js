// 宏观经济日历:重大数据(CPI/FOMC/非农等)的发布时间与 surprise 计算,
// 以及发布前后的"黑窗"判定(黑窗内不执行新的买入分配,卖出/止损不受影响)。
// 纯函数(computeSurprise / isInBlackout / filterHighImportanceUs)与抓取薄层分离,前者可单测。
import { config } from '../config.js';
import { getEconomicCalendar } from './fmp.js';

/**
 * 实际值 vs 预期值的意外幅度。
 * 优先与 estimate 比,缺失退回 previous;两者皆缺或 actual 缺失返回 null。
 * 返回 { surprise, basis: 'estimate'|'previous' } 或 null;surprise 为相对偏差(±小数)。
 */
export function computeSurprise({ actual, estimate, previous } = {}) {
  const act = Number(actual);
  if (!Number.isFinite(act)) return null;
  for (const [basis, raw] of [
    ['estimate', estimate],
    ['previous', previous],
  ]) {
    const ref = Number(raw);
    if (!Number.isFinite(ref)) continue;
    // 基准为 0 时相对偏差无意义(0→0.2 这类利率/百分比数据),退化为绝对差
    const surprise = ref === 0 ? act : (act - ref) / Math.abs(ref);
    return { surprise: Number(surprise.toFixed(4)), basis };
  }
  return null;
}

/** FMP 日历时间为 UTC 的 "YYYY-MM-DD HH:mm:ss",统一解析为毫秒时间戳;无效返回 null */
export function parseCalendarDate(raw) {
  if (!raw) return null;
  const iso = /Z|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${String(raw).replace(' ', 'T')}Z`;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : null;
}

/** 美国高重要性事件(黑窗与 surprise 只看这些;impact/importance 字段两种命名都兼容) */
export function filterHighImportanceUs(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    if (!r || (r.country || '').toUpperCase() !== 'US') return false;
    const importance = String(r.impact ?? r.importance ?? '').toLowerCase();
    return importance === 'high';
  });
}

/**
 * 黑窗判定:now 落在任一事件发布时刻的 [前 beforeMinutes, 后 afterMinutes] 窗口内。
 * 返回 { inBlackout, event, until }(until 为最近一个命中窗口的结束时刻,ISO)。
 */
export function isInBlackout(now, events, { beforeMinutes, afterMinutes } = {}) {
  const ts = now instanceof Date ? now.getTime() : Number(now);
  const before = (Number(beforeMinutes) || 0) * 60_000;
  const after = (Number(afterMinutes) || 0) * 60_000;
  if (before <= 0 && after <= 0) return { inBlackout: false, event: null, until: null };
  let hit = null;
  let hitEnd = 0;
  for (const ev of Array.isArray(events) ? events : []) {
    const evTs = parseCalendarDate(ev?.date);
    if (evTs == null) continue;
    const end = evTs + after;
    if (ts >= evTs - before && ts <= end && end > hitEnd) {
      hit = ev;
      hitEnd = end;
    }
  }
  return hit
    ? { inBlackout: true, event: hit, until: new Date(hitEnd).toISOString() }
    : { inBlackout: false, event: null, until: null };
}

// ── 抓取薄层(进程内缓存)──

const state = {
  events: [], // 高重要性美国事件(全量字段,含 estimate/previous/actual)
  fetchedAt: null,
  unavailable: false, // FMP 套餐不含该端点(403/404),一次告警后停用
};

function isPlanError(err) {
  return /请求失败 40[34]\b/.test(err?.message || '');
}

/** 刷新经济日历(昨天 ~ 未来 3 天),由调度器周期调用;瞬时网络错误下轮重试 */
export async function refreshCalendar() {
  if (!config.enableMacro || state.unavailable || !config.fmpApiKey) return;
  const fmt = (d) => d.toISOString().slice(0, 10);
  const now = Date.now();
  const from = fmt(new Date(now - 24 * 3600_000));
  const to = fmt(new Date(now + 3 * 24 * 3600_000));
  try {
    const rows = await getEconomicCalendar(from, to);
    state.events = filterHighImportanceUs(rows);
    state.fetchedAt = new Date().toISOString();
    console.log(`[calendar] 经济日历已刷新:${state.events.length} 个高重要性美国事件(${from} ~ ${to})`);
  } catch (err) {
    if (isPlanError(err)) {
      state.unavailable = true;
      console.warn('[calendar] 当前数据套餐不含经济日历端点,黑窗保护停用(其余宏观功能不受影响)');
      return;
    }
    console.warn(`[calendar] 刷新经济日历失败(下轮重试): ${err.message}`);
  }
}

/** 当前黑窗状态;日历不可用/未启用时恒为不在黑窗(黑窗是增强而非安全线,fail-open) */
export function getBlackoutState(now = new Date()) {
  if (state.unavailable || !state.fetchedAt) {
    return { available: false, inBlackout: false, event: null, until: null };
  }
  return {
    available: true,
    ...isInBlackout(now, state.events, {
      beforeMinutes: config.blackoutBeforeMinutes,
      afterMinutes: config.blackoutAfterMinutes,
    }),
  };
}

/** 即将到来/今日的高重要性事件(/api/macro 展示用),按时间升序 */
export function getUpcomingEvents(now = new Date(), horizonHours = 72) {
  const ts = now.getTime();
  return state.events
    .map((ev) => ({ ev, at: parseCalendarDate(ev.date) }))
    .filter(({ at }) => at != null && at >= ts - 6 * 3600_000 && at <= ts + horizonHours * 3600_000)
    .sort((a, b) => a.at - b.at)
    .map(({ ev }) => ev);
}

/** 给宏观事件匹配同日同类日历数据,回填数值 surprise(best-effort,匹配不到返回 null) */
export function matchCalendarSurprise(eventType, occurredAt = new Date()) {
  if (!state.fetchedAt || state.unavailable) return null;
  const KEYWORDS = {
    CPI: /\bcpi\b|consumer price/i,
    PPI: /\bppi\b|producer price/i,
    NFP: /nonfarm|non-farm|payroll/i,
    GDP: /\bgdp\b/i,
    FOMC: /fomc|fed (funds )?(interest )?rate|federal funds/i,
  };
  const pattern = KEYWORDS[eventType];
  if (!pattern) return null;
  // "同日"按美东日历日:UTC 日界会让美东 20 点后的文章匹配失败或错配到次日。
  // 沿 etMidnightUtcIso 的先例分别尝试 EST/EDT 偏移,取换算回美东后仍为当日零点的那个
  const ET_DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  const ET_HOUR_FMT = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const etDay = ET_DAY_FMT.format(new Date(occurredAt));
  for (const offset of ['-05:00', '-04:00']) {
    const candidate = new Date(`${etDay}T00:00:00${offset}`);
    if (ET_DAY_FMT.format(candidate) === etDay && Number(ET_HOUR_FMT.format(candidate)) === 0) {
      const dayStart = candidate.getTime();
      const dayEnd = dayStart + 24 * 3600_000;
      return findSurpriseInWindow(pattern, dayStart, dayEnd);
    }
  }
  return null;
}

function findSurpriseInWindow(pattern, dayStart, dayEnd) {
  for (const ev of state.events) {
    const at = parseCalendarDate(ev.date);
    if (at == null || at < dayStart || at >= dayEnd) continue;
    if (!pattern.test(ev.event || '')) continue;
    const result = computeSurprise(ev);
    if (result) return result;
  }
  return null;
}

/** 日历是否可用(套餐含端点且至少成功抓取过一次) */
export function isCalendarAvailable() {
  return !state.unavailable && Boolean(state.fetchedAt);
}

// 注意:管理重置不清空日历缓存——经济日历是外部市场数据,与业务数据无关;
// 清空会让页面在下一次轮询(默认 60 分钟)前误报「经济日历不可用」。
