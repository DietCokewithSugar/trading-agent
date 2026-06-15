// 宏观经济日历:重大数据(CPI/FOMC/非农等)的发布时间与 surprise 计算,
// 以及发布前后的"黑窗"判定(黑窗内不执行新的买入分配,卖出/止损不受影响)。
// 纯函数(computeSurprise / isInBlackout / filterHighImportanceUs)与抓取薄层分离,前者可单测。
import { config } from '../config.js';
import { getEconomicCalendar } from './fmp.js';
import {
  classifyCalendarEventType,
  deriveEventKey,
  inflationSurpriseDirection,
  surpriseWeight,
  isFactsTableMissing,
  findFactByKey,
  insertFact,
  updateFact,
} from './macroFacts.js';

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
    // 已出实际值的周期性数据 → 生成/更新宏观事实(020,数据事实层);失败只告警,不影响黑窗
    await syncCalendarFacts(state.events).catch((e) => console.warn(`[calendar] 同步宏观事实失败: ${e.message}`));
  } catch (err) {
    if (isPlanError(err)) {
      state.unavailable = true;
      console.warn('[calendar] 当前数据套餐不含经济日历端点,黑窗保护停用(其余宏观功能不受影响)');
      return;
    }
    console.warn(`[calendar] 刷新经济日历失败(下轮重试): ${err.message}`);
  }
}

/** 日历事实的档位由意外幅度决定:只有显著超预期才给 1 档(可触发 macro_shock),
 * 符合预期/轻微偏离落到 3 档(几乎不动风险分)——避免"CPI 一发布就冻结买入"。 */
function calendarTierFromSurprise(surpriseScore) {
  if (surpriseScore >= 1.3) return 1; // 显著超预期
  if (surpriseScore >= 1.1) return 2; // 中等偏离
  return 3; // 符合预期 / 轻微
}

/**
 * 把已出实际值的周期性数据同步成宏观事实(020):按 event_key upsert,数值意外幅度
 * 确定性推出方向(CPI/PPI/PCE/FOMC),作为不依赖新闻的"数据事实层"。
 * macro_facts 表缺失则整体跳过(回退纯新闻事实/事件流)。
 */
async function syncCalendarFacts(events) {
  if (isFactsTableMissing()) return;
  for (const ev of Array.isArray(events) ? events : []) {
    const actual = Number(ev?.actual);
    if (!Number.isFinite(actual)) continue; // 未发布/无实际值,不建事实
    const eventType = classifyCalendarEventType(ev.event);
    if (!eventType) continue; // 只为可确定性去重的周期性数据建事实
    const releaseTs = parseCalendarDate(ev.date);
    if (releaseTs == null) continue;
    const eventKey = deriveEventKey(eventType, new Date(releaseTs));
    if (!eventKey) continue;

    const surprise = computeSurprise(ev);
    const surpriseScore = surprise ? surpriseWeight(eventType, surprise.surprise, surprise.basis) : 1;
    const dir = inflationSurpriseDirection(eventType, surprise?.surprise);

    const existing = await findFactByKey(eventKey);
    if (existing === undefined) return; // 表缺失,停止本轮

    const numeric = {
      actual,
      estimate: Number.isFinite(Number(ev.estimate)) ? Number(ev.estimate) : null,
      previous: Number.isFinite(Number(ev.previous)) ? Number(ev.previous) : null,
      surprise: surprise?.surprise ?? null,
      surprise_score: surpriseScore,
      has_actual: true,
      release_time: new Date(releaseTs).toISOString(),
    };

    if (existing) {
      // 数值已一致则跳过(每小时刷新避免无谓写入);否则回填数值
      if (existing.has_actual && Number(existing.actual) === actual) continue;
      const patch = { ...numeric };
      // 仅在事实尚无方向(中性,无论日历独建还是新闻待解释)时,由数据意外确定方向;
      // 新闻已委定方向时不覆盖,只更新数值与意外权重(数据 > 新闻仅限于"补位",不"夺权")
      if (existing.macro_direction === 'neutral') {
        patch.macro_direction = dir.macro_direction;
        patch.rates_signal = dir.rates_signal;
        patch.inflation_signal = dir.inflation_signal;
        patch.growth_signal = dir.growth_signal;
        patch.surprise_direction = dir.surprise_direction;
        patch.market_impact_tier = calendarTierFromSurprise(surpriseScore);
      }
      const updated = await updateFact(existing.id, patch);
      if (updated === undefined) return;
      console.log(`[calendar] 宏观事实回填 ${eventKey}: actual=${actual} 意外×${surpriseScore} → ${updated.macro_direction}`);
      continue;
    }

    const row = {
      event_key: eventKey,
      event_type: eventType,
      macro_direction: dir.macro_direction,
      ...numeric,
      surprise_direction: dir.surprise_direction,
      rates_signal: dir.rates_signal,
      inflation_signal: dir.inflation_signal,
      growth_signal: dir.growth_signal,
      affected_sectors: [],
      market_impact_tier: calendarTierFromSurprise(surpriseScore),
      confidence: 0.8, // 已发布的硬数据,高置信
      summary: `${eventType} 数据发布(实际 ${actual})`,
      source_count: 0, // 日历独建,尚无新闻
      source_domains: [],
      // 时间衰减锚定在发布时刻,而非入库时刻
      created_at: new Date(releaseTs).toISOString(),
    };
    const inserted = await insertFact(row);
    if (inserted === undefined) return;
    if (inserted) console.log(`[calendar] 新宏观事实 ${eventKey} ${inserted.macro_direction} 第${inserted.market_impact_tier}档(意外×${surpriseScore})`);
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
