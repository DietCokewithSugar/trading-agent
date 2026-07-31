/**
 * 估值看板(033)编排层,日志前缀 [valuation]:
 * 组装「美股估值与情绪监控看板」载荷 —— 纳指/标普/VIX 报价与技术指标(FMP)、
 * 恐惧贪婪情绪(fearGreed.js)、指数 PE 及历史分位(indexValuation.js)、
 * 六信号三态、五档定投倍数与今日市场结论(valuationLogic.js 纯函数)。
 *
 * 观察层约定:
 *  - 绝不整体抛错:各子源 Promise.allSettled,任一失败仅对应字段/卡片为 null(state:'na');
 *  - 进程内缓存 VALUATION_CACHE_MINUTES,页面访问超龄现算;调度器每日收盘后强刷一次
 *    并把当日指标 upsert 进 valuation_snapshots(PE/情绪历史积累,喂月度图 PE 线);
 *  - 表缺失只停用历史积累(一次告警),看板其余功能照常;管理重置不清本表(外部市场数据);
 *  - 公开载荷不含任何供应商名。
 */
import { config } from '../config.js';
import { supabase } from '../db.js';
import { getQuote, getHistoricalPrices } from './fmp.js';
import { rsi } from './backtest/indicators.js';
import { etDayKey } from './metrics.js';
import { getFearGreed } from './fearGreed.js';
import { getIndexValuation } from './indexValuation.js';
import {
  buildSignals,
  decideDcaTier,
  buildConclusion,
  classifyVixLevel,
  smaLast,
  dropFromRecentHigh,
  percentileRank,
  monthlyAverages,
  vixMonthlySeries,
  DCA_TIERS,
} from './valuationLogic.js';

const INDEX_SYMBOLS = { ndx: '^IXIC', spx: '^GSPC' };
const VIX_SYMBOL = '^VIX';

const ET_HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  hourCycle: 'h23',
});

const state = {
  board: null,
  computedAt: 0,
  inflight: null,
  lastDailyEtDay: null, // 当日快照已落库的美东日戳
  tableMissing: false, // valuation_snapshots 缺表(033 未执行),一次告警后停用历史积累
  tableWarned: false,
  lastComputeWarnAt: 0,
};

const fmtDate = (d) => d.toISOString().slice(0, 10);
const round = (v, digits = 2) =>
  Number.isFinite(Number(v)) && v !== null ? Math.round(Number(v) * 10 ** digits) / 10 ** digits : null;

function isMissingTable(error) {
  return (
    error?.code === '42P01' || /does not exist|relation .* 不存在/i.test(error?.message || '')
  );
}

/** 报价 + 日线 → 单指数指标组(全部 null 安全;quote/history 可各自缺席) */
function buildIndexMetrics(quote, rows, cfg) {
  const closes = (rows || []).map((r) => Number(r.price)).filter(Number.isFinite);
  const lastRowDate = rows?.length ? rows[rows.length - 1].date : null;
  const quotePrice = Number(quote?.effective_price ?? quote?.price);
  // 盘中让技术指标吃到最新价:日线末行还停在昨日时,把现价当作今日的「进行中收盘」追加
  if (Number.isFinite(quotePrice) && quotePrice > 0 && lastRowDate && lastRowDate < etDayKey()) {
    closes.push(quotePrice);
  }
  const price =
    Number.isFinite(quotePrice) && quotePrice > 0
      ? quotePrice
      : closes.length
        ? closes[closes.length - 1]
        : null;

  const chgRaw = Number(quote?.changesPercentage ?? quote?.changePercentage);
  const changePercent = Number.isFinite(chgRaw) ? chgRaw : null;

  const quoteSma200 = Number(quote?.priceAvg200);
  const sma200 =
    Number.isFinite(quoteSma200) && quoteSma200 > 0 ? quoteSma200 : smaLast(closes, 200);
  const sma200Gap = price && sma200 ? ((price - sma200) / sma200) * 100 : null;

  // 52 周区间:报价字段优先,缺失时用近 252 个交易日兜底
  const tail252 = closes.slice(-252);
  const quoteHigh = Number(quote?.yearHigh);
  const quoteLow = Number(quote?.yearLow);
  const yearHigh =
    Number.isFinite(quoteHigh) && quoteHigh > 0
      ? quoteHigh
      : tail252.length
        ? Math.max(...tail252)
        : null;
  const yearLow =
    Number.isFinite(quoteLow) && quoteLow > 0
      ? quoteLow
      : tail252.length
        ? Math.min(...tail252)
        : null;
  const drawdown52w = price && yearHigh ? ((price - yearHigh) / yearHigh) * 100 : null;
  const rangePosition =
    price && yearHigh && yearLow && yearHigh > yearLow
      ? ((price - yearLow) / (yearHigh - yearLow)) * 100
      : null;

  const rsiSeries = rsi(closes, cfg.rsiPeriod ?? 6);
  const rsiLast = [...rsiSeries].reverse().find((v) => v !== null) ?? null;

  return {
    price: round(price, 2),
    change_percent: round(changePercent, 2),
    sma200: round(sma200, 2),
    sma200_gap_percent: round(sma200Gap, 2),
    year_high: round(yearHigh, 2),
    year_low: round(yearLow, 2),
    year_range_position: round(rangePosition, 1),
    drawdown_52w: round(drawdown52w, 2),
    drop_25d: round(dropFromRecentHigh(closes, cfg.crashWindowDays ?? 25), 2),
    rsi6: round(rsiLast, 1),
  };
}

/** valuation_snapshots → 近 N 个月的 PE 分位/情绪月均(缺表/未配库时 []) */
async function loadSnapshotMonths(months) {
  if (state.tableMissing) return [];
  try {
    const since = new Date();
    since.setMonth(since.getMonth() - months - 1);
    const { data, error } = await supabase()
      .from('valuation_snapshots')
      .select('snap_date, ndx_pe_pct, spx_pe_pct, fear_greed')
      .gte('snap_date', fmtDate(since))
      .order('snap_date', { ascending: true })
      .limit(400);
    if (error) throw error;
    const toRows = (field) =>
      (data || [])
        .filter((r) => Number.isFinite(Number(r[field])) && r[field] !== null)
        .map((r) => ({ date: r.snap_date, price: Number(r[field]) }));
    const ndx = monthlyAverages(toRows('ndx_pe_pct'));
    const spx = monthlyAverages(toRows('spx_pe_pct'));
    const byMonth = new Map();
    for (const m of ndx) byMonth.set(m.month, { ndx_pe_pct: round(m.avg, 0) });
    for (const m of spx) {
      byMonth.set(m.month, { ...(byMonth.get(m.month) || {}), spx_pe_pct: round(m.avg, 0) });
    }
    return [...byMonth.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([month, v]) => ({ month, ...v }));
  } catch (err) {
    if (isMissingTable(err)) {
      state.tableMissing = true;
      if (!state.tableWarned) {
        state.tableWarned = true;
        console.warn('[valuation] valuation_snapshots 表缺失(033 未执行),PE/情绪历史积累停用,看板其余功能不受影响');
      }
    }
    return [];
  }
}

const settle = (r) => (r.status === 'fulfilled' ? r.value : null);

/** 组装完整看板载荷(不抛错;个别子源失败仅对应字段为 null) */
async function computeBoard() {
  const cfg = config.valuationBoard;
  const now = Date.now();
  const to = fmtDate(new Date(now));
  // 380 天覆盖 SMA200(约 290 个日历日)+ 52 周兜底;VIX 分位回看 N 年
  const fromDaily = fmtDate(new Date(now - 380 * 24 * 3600_000));
  const fromVix = fmtDate(new Date(now - (cfg.vixHistoryYears ?? 5) * 366 * 24 * 3600_000));

  const [
    ndxQuote,
    spxQuote,
    vixQuote,
    ndxHist,
    spxHist,
    vixHist,
    fearGreed,
    indexVal,
    snapshotMonths,
  ] = (
    await Promise.allSettled([
      getQuote(INDEX_SYMBOLS.ndx),
      getQuote(INDEX_SYMBOLS.spx),
      getQuote(VIX_SYMBOL),
      getHistoricalPrices(INDEX_SYMBOLS.ndx, fromDaily, to),
      getHistoricalPrices(INDEX_SYMBOLS.spx, fromDaily, to),
      getHistoricalPrices(VIX_SYMBOL, fromVix, to),
      getFearGreed(),
      getIndexValuation(),
      loadSnapshotMonths(cfg.chartMonths ?? 6),
    ])
  ).map(settle);

  const ndx = buildIndexMetrics(ndxQuote, ndxHist, cfg);
  const spx = buildIndexMetrics(spxQuote, spxHist, cfg);

  const vixCloses = (vixHist || []).map((r) => Number(r.price)).filter(Number.isFinite);
  const vixPriceRaw = Number(vixQuote?.price);
  const vixPrice = Number.isFinite(vixPriceRaw) && vixPriceRaw > 0
    ? vixPriceRaw
    : vixCloses.length
      ? vixCloses[vixCloses.length - 1]
      : null;
  const vixChgRaw = Number(vixQuote?.changesPercentage ?? vixQuote?.changePercentage);

  const pePct = { ndx: indexVal?.ndx?.pe_pct ?? null, spx: indexVal?.spx?.pe_pct ?? null };
  const signals = buildSignals(
    {
      vix: vixPrice,
      fearGreed: fearGreed?.score ?? null,
      rsi: { ndx: ndx.rsi6, spx: spx.rsi6 },
      pePct,
      drawdown: { ndx: ndx.drawdown_52w, spx: spx.drawdown_52w },
      crash: { ndx: ndx.drop_25d, spx: spx.drop_25d },
    },
    cfg
  );

  // 定投判定的估值口径:双指数分位取较高者(任一偏贵即保守减量)
  const pePcts = [pePct.ndx, pePct.spx].filter((v) => Number.isFinite(Number(v)) && v !== null);
  const dca = decideDcaTier(
    { signals, fearGreed: fearGreed?.score ?? null, pePct: pePcts.length ? Math.max(...pePcts) : null },
    cfg
  );
  const conclusion = buildConclusion({
    pe: pePct,
    fearGreed: fearGreed?.score ?? null,
    vix: vixPrice,
    trendGap: { ndx: ndx.sma200_gap_percent, spx: spx.sma200_gap_percent },
    multiplier: dca.multiplier,
  });

  // 月度图:VIX 月均+分位由日线现算;PE 分位月均来自快照积累(缺表/空表时只有 VIX 线)
  const vixSeries = vixMonthlySeries(vixHist || [], cfg.chartMonths ?? 6);
  const peByMonth = new Map((snapshotMonths || []).map((m) => [m.month, m]));
  const months = vixSeries.map((m) => ({
    ...m,
    ndx_pe_pct: peByMonth.get(m.month)?.ndx_pe_pct ?? null,
    spx_pe_pct: peByMonth.get(m.month)?.spx_pe_pct ?? null,
  }));
  // VIX 线整体缺席(历史拉取失败)时退化为纯快照月份,PE 线仍可画
  if (!months.length && snapshotMonths?.length) {
    months.push(
      ...snapshotMonths.slice(-(cfg.chartMonths ?? 6)).map((m) => ({
        month: m.month,
        vix_avg: null,
        vix_pct: null,
        ndx_pe_pct: m.ndx_pe_pct ?? null,
        spx_pe_pct: m.spx_pe_pct ?? null,
      }))
    );
  }

  return {
    available: true,
    updated_at: new Date().toISOString(),
    refresh: {
      daily_hour_et: config.valuationRefreshEtHour,
      cache_minutes: config.valuationCacheMinutes,
    },
    indexes: {
      ndx: { label: '纳斯达克综合', ...ndx, pe: indexVal?.ndx?.pe ?? null, pe_pct: pePct.ndx },
      spx: { label: '标普 500', ...spx, pe: indexVal?.spx?.pe ?? null, pe_pct: pePct.spx },
      vix: {
        label: 'VIX 恐慌指数',
        price: round(vixPrice, 2),
        change_percent: Number.isFinite(vixChgRaw) ? round(vixChgRaw, 2) : null,
        level: classifyVixLevel(vixPrice),
        percentile_5y: round(percentileRank(vixCloses, vixPrice), 0),
        history_years: cfg.vixHistoryYears ?? 5,
      },
    },
    signals,
    summary: {
      triggered: signals.filter((s) => s.state === 'triggered').length,
      near: signals.filter((s) => s.state === 'near').length,
    },
    dca: { tiers: DCA_TIERS, active_multiplier: dca.multiplier, reason: dca.reason },
    conclusion,
    chart: { months, available: months.length > 0 },
    sources: {
      sentiment: Boolean(fearGreed),
      valuation: Boolean(indexVal),
      sentiment_as_of: fearGreed?.fetched_at ?? null,
      valuation_as_of: indexVal?.fetched_at ?? null,
    },
  };
}

/**
 * 看板载荷(进程内缓存,超龄现算;并发共享同一次计算)。
 * forceRefresh 供每日调度强刷;计算异常时回退上一次成功载荷,从不抛错。
 */
export async function getBoard({ forceRefresh = false } = {}) {
  if (!config.enableValuationBoard) return { available: false };
  const ttlMs = Math.max(config.valuationCacheMinutes, 1) * 60_000;
  if (!forceRefresh && state.board && Date.now() - state.computedAt < ttlMs) {
    return state.board;
  }
  if (!state.inflight) {
    state.inflight = computeBoard()
      .then((board) => {
        state.board = board;
        state.computedAt = Date.now();
        return board;
      })
      .catch((err) => {
        // computeBoard 内部已 allSettled,走到这里属于意外;限频告警并回退旧载荷
        if (Date.now() - state.lastComputeWarnAt > 10 * 60_000) {
          state.lastComputeWarnAt = Date.now();
          console.warn(`[valuation] 看板组装异常(回退旧数据): ${err.message}`);
        }
        return state.board || { available: false };
      })
      .finally(() => {
        state.inflight = null;
      });
  }
  return state.inflight;
}

/** 当日指标快照 upsert(历史积累,喂月度图 PE 线);缺表一次告警后跳过 */
async function persistDailySnapshot(board, etDay) {
  if (state.tableMissing) return;
  const row = {
    snap_date: etDay,
    ndx_pe: board.indexes?.ndx?.pe ?? null,
    ndx_pe_pct: board.indexes?.ndx?.pe_pct ?? null,
    spx_pe: board.indexes?.spx?.pe ?? null,
    spx_pe_pct: board.indexes?.spx?.pe_pct ?? null,
    fear_greed: board.signals?.find((s) => s.key === 'fear_greed')?.value ?? null,
    vix: board.indexes?.vix?.price ?? null,
  };
  try {
    const { error } = await supabase()
      .from('valuation_snapshots')
      .upsert(row, { onConflict: 'snap_date' });
    if (error) throw error;
  } catch (err) {
    if (isMissingTable(err)) {
      state.tableMissing = true;
      if (!state.tableWarned) {
        state.tableWarned = true;
        console.warn('[valuation] valuation_snapshots 表缺失(033 未执行),PE/情绪历史积累停用,看板其余功能不受影响');
      }
      return;
    }
    console.warn(`[valuation] 当日快照写入失败(仅影响历史积累): ${err.message}`);
  }
}

/**
 * 每日刷新探针(调度器每 10 分钟调用):美东 ≥ VALUATION_REFRESH_ET_HOUR 且当日未跑时,
 * 强刷看板并落当日快照。核心数据全缺时不记当日戳,下个探针继续重试。
 */
export async function maybeDailyValuationRefresh() {
  if (!config.enableValuationBoard) return;
  const etDay = etDayKey();
  const etHour = Number(ET_HOUR_FMT.format(new Date()));
  if (etHour < config.valuationRefreshEtHour || state.lastDailyEtDay === etDay) return;

  const board = await getBoard({ forceRefresh: true });
  if (!board?.available) return;
  const hasData =
    board.indexes?.vix?.price !== null ||
    board.indexes?.ndx?.price !== null ||
    board.sources?.sentiment ||
    board.sources?.valuation;
  if (!hasData) {
    if (Date.now() - state.lastComputeWarnAt > 10 * 60_000) {
      state.lastComputeWarnAt = Date.now();
      console.warn('[valuation] 每日刷新:各数据源均无数据,稍后重试');
    }
    return;
  }
  await persistDailySnapshot(board, etDay);
  state.lastDailyEtDay = etDay;
  console.log(`[valuation] 每日看板刷新完成(${etDay},信号触发 ${board.summary.triggered} / 接近 ${board.summary.near})`);
}

/** 测试用:清空进程内缓存与日戳 */
export function clearValuationBoardState() {
  state.board = null;
  state.computedAt = 0;
  state.inflight = null;
  state.lastDailyEtDay = null;
  state.tableMissing = false;
  state.tableWarned = false;
  state.lastComputeWarnAt = 0;
}
