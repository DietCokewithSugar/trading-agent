import { supabase } from '../db.js';
import { config } from '../config.js';
import { getProfile } from './fmp.js';
import { etDayRangeUtc } from './riskControls.js';
import { listMacroEventsForDay } from './macroService.js';
import { sectorMultiplier } from './macroRegime.js';
import { isHalted } from './halt.js';
import { SECTOR_KEYS, sectorMeta, summarizeSectorSentiment } from './sectors.js';

/**
 * 板块层取数(034,日志前缀 [sector]):
 *  - 分析入库时按分析主体的公司档案写入行业(newsService 调用 resolveSectorForSymbol);
 *  - 历史行由 backfillAnalysisSectors 逐批补齐(按标的粒度:一次档案请求补该标的全部行);
 *  - getSectorBoard 汇总某一天/某窗口的板块整体利好利空(叠加宏观层的板块乘数)。
 *
 * 纯展示/筛选层:全部 fail-open,任何失败都不得影响新闻分析与交易路径;
 * 034 未执行(sector 列缺失)时整体降级为"不可用",前端隐藏板块看板与筛选。
 */

const PAGE_SIZE = 1000;
const BOARD_CACHE_MS = 60_000;
// 公司档案没有行业的标的(ETF/基金/退市)不必每轮重取:进程内冷却 12 小时
const UNRESOLVED_COOLDOWN_MS = 12 * 3600_000;
// 每次回填扫描的缺板块行数上限(其中按标的去重后最多补 backfillLimit 个标的)
const BACKFILL_SCAN_ROWS = 500;

const state = {
  columnMissing: false, // 034 未执行
  columnWarned: false,
  backfilling: false,
  unresolved: new Map(), // symbol -> 冷却到期时间戳
  scanOffset: 0, // 待办扫描窗口的偏移(整窗都是冷却中的标的时下移,防止毒行钉死队列)
  boardCache: new Map(), // cacheKey -> { at, payload }
};

function isMissingColumn(error) {
  return /sector/i.test(error?.message || '') && /column|字段/i.test(error?.message || '');
}

function markColumnMissing() {
  state.columnMissing = true;
  if (!state.columnWarned) {
    state.columnWarned = true;
    console.warn('[sector] news_analyses.sector 列不可用,板块划分功能已停用(请执行 034 迁移)');
  }
}

/** 管理重置:分析行已清空,缓存与冷却表不得幸存(列缺失标记是 schema 事实,保留) */
export function clearSectorState() {
  state.boardCache.clear();
  state.unresolved.clear();
  state.scanOffset = 0;
  state.backfilling = false;
}

/** 板块功能是否可用(034 已执行);前端据此隐藏板块筛选与看板 */
export function isSectorAvailable() {
  return !state.columnMissing;
}

/**
 * 标的所属行业(数据源原始行业名,写库口径)。
 * 公司档案 24 小时进程内缓存,交易路径本来也要取同一份档案,新增成本仅限新标的;
 * 取不到档案/档案无行业返回 null(该行留空,进未分类桶)。
 */
export async function resolveSectorForSymbol(symbol) {
  if (!symbol) return null;
  try {
    const profile = await getProfile(String(symbol).toUpperCase());
    const raw = profile?.sector ? String(profile.sector).trim() : '';
    return raw || null;
  } catch (err) {
    console.warn(`[sector] ${symbol} 行业解析失败: ${err.message}`);
    return null;
  }
}

/**
 * 历史分析行的板块回填:扫描最近的缺板块行 → 按标的去重 → 逐个取公司档案 →
 * 一次 update 补齐该标的的全部缺失行。单飞(上一轮没跑完就跳过),全程 fail-open。
 * 由 runCycle 的 fullFetch 轮(约 5 分钟一次)不阻塞地触发。
 */
export async function backfillAnalysisSectors({ limit } = {}) {
  if (state.columnMissing || state.backfilling || isHalted()) return { filled: 0, skipped: true };
  const symbolLimit = Math.max(Number(limit) || config.sectorBackfillSymbols, 1);
  state.backfilling = true;
  try {
    const { data, error } = await supabase()
      .from('news_analyses')
      .select('symbol')
      .is('sector', null)
      .order('created_at', { ascending: false })
      .range(state.scanOffset, state.scanOffset + BACKFILL_SCAN_ROWS - 1);
    if (error) {
      if (isMissingColumn(error)) markColumnMissing();
      else console.warn(`[sector] 板块回填取待办失败: ${error.message}`);
      return { filled: 0, skipped: true };
    }

    const now = Date.now();
    const symbols = [];
    const seen = new Set();
    for (const row of data || []) {
      const symbol = row?.symbol ? String(row.symbol).toUpperCase() : null;
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      const cooldownUntil = state.unresolved.get(symbol);
      if (cooldownUntil && cooldownUntil > now) continue;
      symbols.push(symbol);
      if (symbols.length >= symbolLimit) break;
    }
    if (!symbols.length) {
      // 整窗都是冷却中的标的(公司档案本就没有行业:ETF/基金/退市)——窗口下移继续挖,
      // 挖到底回到队首。否则这些"毒行"会永远钉在按时间倒序的窗口里,更老的行永远排不上
      state.scanOffset =
        (data || []).length < BACKFILL_SCAN_ROWS ? 0 : state.scanOffset + BACKFILL_SCAN_ROWS;
      return { filled: 0, symbols: 0 };
    }
    state.scanOffset = 0;

    let filled = 0;
    for (const symbol of symbols) {
      const sector = await resolveSectorForSymbol(symbol);
      if (!sector) {
        // ETF/基金/退市标的:档案里本就没有行业,冷却后再试,别每轮都打接口
        state.unresolved.set(symbol, Date.now() + UNRESOLVED_COOLDOWN_MS);
        // 长会话防膨胀:表变大时先清掉已到期的条目(到期条目本就该被重新尝试)
        if (state.unresolved.size > 5000) {
          const t = Date.now();
          for (const [sym, until] of state.unresolved) {
            if (until <= t) state.unresolved.delete(sym);
          }
        }
        continue;
      }
      const { error: updateError, count } = await supabase()
        .from('news_analyses')
        .update({ sector }, { count: 'exact' })
        .eq('symbol', symbol)
        .is('sector', null);
      if (updateError) {
        if (isMissingColumn(updateError)) {
          markColumnMissing();
          break;
        }
        console.warn(`[sector] ${symbol} 板块回填写入失败: ${updateError.message}`);
        continue;
      }
      filled += count || 0;
    }
    if (filled) {
      console.log(`[sector] 板块回填完成: ${symbols.length} 个标的 / ${filled} 行`);
      state.boardCache.clear(); // 回填改变了历史窗口的聚合结果
    }
    return { filled, symbols: symbols.length };
  } catch (err) {
    console.warn(`[sector] 板块回填异常: ${err.message}`);
    return { filled: 0, skipped: true };
  } finally {
    state.backfilling = false;
  }
}

/** 按 PAGE_SIZE 翻页取窗口内的分析行,超出上限截断并明示 */
async function fetchAnalysesInWindow(startIso, endIso, maxRows) {
  const rows = [];
  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    // 末页可能小于 PAGE_SIZE(上限不是整数页):取满即视为"还有",取不满才是真的到底
    const wanted = Math.min(PAGE_SIZE, maxRows - from);
    const { data, error } = await supabase()
      .from('news_analyses')
      .select(
        'symbol, sector, sentiment, tier, confidence, final_confidence, news_articles!inner(published_at)'
      )
      .gte('news_articles.published_at', startIso)
      .lt('news_articles.published_at', endIso)
      .order('created_at', { ascending: false })
      .range(from, from + wanted - 1);
    if (error) return { rows, truncated: false, error };
    rows.push(...(data || []));
    if (!data || data.length < wanted) return { rows, truncated: false, error: null };
  }
  return { rows, truncated: true, error: null };
}

/** 宏观层的板块乘数(0.6–1.2):把宏观事件的受影响行业投影到 11 个板块上;不可用返回空表 */
async function loadMacroTilt(endTs) {
  if (!config.enableMacro) return {};
  try {
    const validityMs = config.macroEventValidityHours * 3600_000;
    const events = await listMacroEventsForDay(
      new Date(endTs - validityMs).toISOString(),
      new Date(endTs).toISOString()
    );
    if (!events?.length) return {};
    // 历史视图按窗口末端衰减,实时视图按当下(窗口末端是未来时刻)
    const asOf = new Date(Math.min(endTs, Date.now()));
    const tilt = {};
    for (const key of SECTOR_KEYS) {
      const meta = sectorMeta(key);
      const mult = sectorMultiplier(meta.name, events, asOf, {
        validityHours: config.macroEventValidityHours,
      });
      if (mult !== 1) tilt[key] = mult;
    }
    return tilt;
  } catch (err) {
    console.warn(`[sector] 宏观板块乘数取数失败: ${err.message}`);
    return {};
  }
}

/**
 * 板块情绪看板:某个美东日(date=YYYY-MM-DD,与新闻页单日视图同口径)或
 * 最近 hours 小时窗口内,各板块的利好/利空构成与净情绪分。
 * 窗口按文章发布时间划分(与新闻列表一致),不是分析时间。
 */
export async function getSectorBoard({ date = null, hours = 24 } = {}) {
  if (state.columnMissing) return { available: false, reason: 'migration' };

  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : null;
  const dayRange = dateKey ? etDayRangeUtc(dateKey) : null;
  const windowHours = Math.min(Math.max(Math.trunc(Number(hours) || 24), 1), 168);
  const startIso = dayRange
    ? dayRange.startIso
    : new Date(Date.now() - windowHours * 3600_000).toISOString();
  const endIso = dayRange ? dayRange.endIso : new Date().toISOString();

  const cacheKey = dayRange ? `date:${dateKey}` : `hours:${windowHours}`;
  const cached = state.boardCache.get(cacheKey);
  if (cached && Date.now() - cached.at < BOARD_CACHE_MS) return cached.payload;

  const { rows, truncated, error } = await fetchAnalysesInWindow(
    startIso,
    endIso,
    config.sectorBoardMaxRows
  );
  if (error) {
    if (isMissingColumn(error)) {
      markColumnMissing();
      return { available: false, reason: 'migration' };
    }
    throw new Error(error.message);
  }

  const summary = summarizeSectorSentiment(rows, { topSymbols: 5 });
  const macroTilt = await loadMacroTilt(Date.parse(endIso));
  const payload = {
    available: true,
    window: {
      date: dateKey,
      hours: dayRange ? null : windowHours,
      start: startIso,
      end: endIso,
      rows: rows.length,
      truncated,
    },
    sectors: summary.sectors.map((s) => ({ ...s, macro_multiplier: macroTilt[s.key] ?? null })),
    unclassified: summary.unclassified,
    totals: summary.totals,
  };
  state.boardCache.set(cacheKey, { at: Date.now(), payload });
  // 缓存键有限(单日键 + 少数窗口键),但长期运行仍做个上界
  if (state.boardCache.size > 60) {
    const oldest = [...state.boardCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) state.boardCache.delete(oldest[0]);
  }
  return payload;
}
