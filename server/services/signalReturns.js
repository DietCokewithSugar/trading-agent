import { supabase } from '../db.js';
import { getQuotes, getHistoricalPrices, getMarketSession } from './fmp.js';
import { isHalted } from './halt.js';

/**
 * 信号前瞻收益(评估层,011 迁移)。
 *
 * 组合盈亏混杂了仓位缩放、止损、风控官等环节,回答不了"分类信号本身有没有 alpha"。
 * 这里对每条非中性分析(包括因去重/置信度不足而未交易的)记录信号时点市场价,
 * 并由后台任务回填三个口径的前瞻收益(百分比,相对 signal_price):
 *  - fwd_return_1h:信号后 1~2 小时窗口内的最新有效价(休市窗口错过则保持空,统计时剔除);
 *  - fwd_return_1d:信号日(美东)之后第 1 个交易日收盘价;
 *  - fwd_return_2d:信号日之后第 2 个交易日收盘价(≈48 小时,与持有上限对齐的决策口径,031)。
 * 旧的 fwd_return_5d 口径已停止回填(±2%/48h 策略下与实盘盈亏几乎无关,列保留历史数据)。
 * 列不存在(011 迁移未执行)时整体停用,主流程不受影响;仅缺 fwd_return_2d(031 未执行)
 * 时只停用 2d 口径,1h/1d 照常。
 */

const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
function etDate(iso) {
  return ET_DATE_FMT.format(new Date(iso));
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

let columnsMissing = false;
let twoDayMissing = false; // 仅缺 fwd_return_2d(031 未执行):只停用 2d 口径,1h/1d 照常
let running = false;

function isMissingColumn(error) {
  return /signal_price|fwd_return/.test(error?.message || '');
}

function warnMissingOnce(context) {
  if (columnsMissing) return;
  columnsMissing = true;
  console.warn(`[signal] news_analyses 缺少前瞻收益列,信号评估停用(请执行 011 迁移;${context})`);
}

function warnTwoDayMissingOnce() {
  if (twoDayMissing) return;
  twoDayMissing = true;
  console.warn('[signal] news_analyses 缺少 fwd_return_2d 列,2 个交易日口径停用(请执行 031 迁移;1h/1d 不受影响)');
}

/** 分析完成后立即记录信号观察价,作为前瞻收益基准(失败不影响主流程) */
export async function recordSignalPrice(analysisId, price) {
  const p = Number(price);
  if (columnsMissing || !Number.isFinite(p) || p <= 0) return;
  const { error } = await supabase()
    .from('news_analyses')
    .update({ signal_price: round4(p) })
    .eq('id', analysisId);
  if (error) {
    if (isMissingColumn(error)) warnMissingOnce('记录信号价');
    else console.warn(`[signal] 记录信号价失败(分析 #${analysisId}): ${error.message}`);
  }
}

/**
 * 纯函数:由信号日之后的日线序列计算 1/2 个交易日前瞻收益(百分比)。
 * rows 为按日期升序的 [{ date: 'YYYY-MM-DD', price }];不足 N 个交易日返回 null。
 */
export function computeDailyForwardReturns({ rows, signalEtDate, signalPrice }) {
  const base = Number(signalPrice);
  if (!Number.isFinite(base) || base <= 0) return { r1d: null, r2d: null };
  const after = (rows || []).filter((r) => r.date > signalEtDate);
  const pct = (p) => round4((Number(p) / base - 1) * 100);
  return {
    r1d: after.length >= 1 ? pct(after[0].price) : null,
    r2d: after.length >= 2 ? pct(after[1].price) : null,
  };
}

/** 1 小时口径:信号后 60~120 分钟窗口内用实时报价回填(窗口被休市/宕机错过则保持空) */
async function backfill1h() {
  // 休市时段不回填:夜间/周末取到的是停滞价,收益恒≈0 会被当成有效样本
  // 系统性压低 1h 命中率;窗口落在休市内的信号按口径约定保持空、统计时剔除。
  // 盘前盘后有真实成交价,照常回填
  if (getMarketSession() === 'closed') return 0;
  const now = Date.now();
  const { data, error } = await supabase()
    .from('news_analyses')
    .select('id, symbol, signal_price')
    .not('signal_price', 'is', null)
    .is('fwd_return_1h', null)
    .gte('created_at', new Date(now - 2 * 3600_000).toISOString())
    .lte('created_at', new Date(now - 3600_000).toISOString())
    .limit(100);
  if (error) throw error;
  if (!data?.length) return 0;

  const quotes = await getQuotes([...new Set(data.map((a) => a.symbol))], 60_000);
  let filled = 0;
  for (const a of data) {
    const quote = quotes.get(a.symbol);
    const price = quote?.effective_price ?? quote?.price;
    const base = Number(a.signal_price);
    if (!Number.isFinite(Number(price)) || !(base > 0)) continue;
    const { error: updErr } = await supabase()
      .from('news_analyses')
      .update({ fwd_return_1h: round4((Number(price) / base - 1) * 100) })
      .eq('id', a.id);
    if (updErr) throw updErr;
    filled += 1;
  }
  return filled;
}

// 股票冷却(毒丸防护):退市股/无日线数据的股票会让回填行永远填不上,
// 又因正序窗口长期占住每轮的行/股票预算,把吞吐拖到 0。
// 历史行情抛错或无已定型日线 → 冷却 12 小时;有日线但本轮 0 填充(边界未定型)→ 冷却 2 小时。
// 冷却中的股票在分组时直接跳过,不消耗当轮股票预算。
const symbolCooldown = new Map(); // symbol -> 冷却截止毫秒时间戳
const COOLDOWN_HARD_MS = 12 * 3600_000;
const COOLDOWN_SOFT_MS = 2 * 3600_000;

/**
 * 取某一口径的到期未回填行:signal_price 非空、该列为空,
 * created_at ∈ [now−30d, now−minAgeMs],正序(最老优先)。
 * 1d/2d 拆成两条独立队列查询——旧实现的 .or() 会让"1d 已填但 2d 未到期"的行反复进窗空转。
 */
async function fetchPending({ column, minAgeMs, limit }) {
  const now = Date.now();
  const { data, error } = await supabase()
    .from('news_analyses')
    .select(`id, symbol, signal_price, created_at, fwd_return_1d${twoDayMissing ? '' : ', fwd_return_2d'}`)
    .not('signal_price', 'is', null)
    .is(column, null)
    .gte('created_at', new Date(now - 30 * 24 * 3600_000).toISOString())
    .lte('created_at', new Date(now - minAgeMs).toISOString())
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

/** 处理一批到期行:按股票分组取日线并回填,返回填充行数(每只股票一次历史行情请求,缓存 1 小时) */
async function fillDailyBatch(pending, { symbolBudget = 30 } = {}) {
  const todayEt = etDate(new Date().toISOString());
  const now = Date.now();

  const bySymbol = new Map();
  for (const a of pending) {
    if ((symbolCooldown.get(a.symbol) || 0) > now) continue;
    const list = bySymbol.get(a.symbol) || [];
    list.push(a);
    bySymbol.set(a.symbol, list);
  }

  let filled = 0;
  let budget = symbolBudget;
  for (const [symbol, items] of bySymbol) {
    if (budget-- <= 0) break;
    const from = etDate(items[0].created_at);
    let rows;
    try {
      rows = await getHistoricalPrices(symbol, from, todayEt);
    } catch (err) {
      symbolCooldown.set(symbol, now + COOLDOWN_HARD_MS);
      console.warn(`[signal] ${symbol} 历史行情获取失败,冷却 12 小时后重试: ${err.message}`);
      continue;
    }
    // FMP 日线端点在交易日盘中会返回当日(未收盘)的行,若拿它当"第 N 个交易日收盘"
    // 会把盘中价写死(回填只填 null、不再修正)。只采用日期早于今天的已定型 K 线,
    // 当日收盘留待下一轮回填——晚一天到账,但口径正确。
    const settledRows = (rows || []).filter((r) => r.date < todayEt);
    if (!settledRows.length) {
      // 查得到接口但没有任何已定型日线:退市/停牌/无数据,大概率永远填不上
      symbolCooldown.set(symbol, now + COOLDOWN_HARD_MS);
      continue;
    }
    let symbolFilled = 0;
    for (const a of items) {
      const { r1d, r2d } = computeDailyForwardReturns({
        rows: settledRows,
        signalEtDate: etDate(a.created_at),
        signalPrice: a.signal_price,
      });
      const update = {};
      if (a.fwd_return_1d === null && r1d !== null) update.fwd_return_1d = r1d;
      // 2d 列缺失(031 未执行)时 a.fwd_return_2d 为 undefined,严格等于 null 不成立 → 不写
      if (a.fwd_return_2d === null && r2d !== null) update.fwd_return_2d = r2d;
      if (!Object.keys(update).length) continue;
      const { error: updErr } = await supabase()
        .from('news_analyses')
        .update(update)
        .eq('id', a.id);
      if (updErr) throw updErr;
      symbolFilled += 1;
    }
    filled += symbolFilled;
    // 有日线却一行都填不上(收盘尚未定型/日期边界):短冷却,别让它每 10 分钟空转占预算
    if (symbolFilled === 0) symbolCooldown.set(symbol, now + COOLDOWN_SOFT_MS);
  }
  return filled;
}

/**
 * 1/2 个交易日口径:两条独立的到期队列。
 * 1d:信号至少 24 小时前(次日收盘可定型);2d:至少 72 小时前(工作日下 2 个交易日
 * 收盘定型的日历下界;跨周末的行由 symbol 冷却吸收,不会反复空转)。返回 { n1d, n2d }。
 */
async function runDailyQueues() {
  const pending1d = await fetchPending({ column: 'fwd_return_1d', minAgeMs: 24 * 3600_000, limit: 400 });
  const n1d = pending1d.length ? await fillDailyBatch(pending1d) : 0;
  if (twoDayMissing) return { n1d, n2d: 0 };
  const pending2d = await fetchPending({ column: 'fwd_return_2d', minAgeMs: 72 * 3600_000, limit: 400 });
  const n2d = pending2d.length ? await fillDailyBatch(pending2d) : 0;
  return { n1d, n2d };
}

/** 缺 fwd_return_2d(031 未执行)时降级为只跑 1d 队列重试一次,不触发 011 级整体停用 */
async function backfillDaily() {
  try {
    return await runDailyQueues();
  } catch (err) {
    if (!twoDayMissing && /fwd_return_2d/.test(err?.message || '')) {
      warnTwoDayMissingOnce();
      return await runDailyQueues();
    }
    throw err;
  }
}

/** 由调度器周期调用(每 10 分钟):回填到期的前瞻收益 */
export async function backfillForwardReturns() {
  if (columnsMissing || running || isHalted()) return;
  running = true;
  try {
    const n1h = await backfill1h();
    const { n1d, n2d } = await backfillDaily();
    if (n1h || n1d || n2d) {
      console.log(`[signal] 前瞻收益回填: 1小时口径 ${n1h} 条,1d 队列 ${n1d} 条,2d 队列 ${n2d} 条`);
    }
  } catch (err) {
    if (isMissingColumn(err)) warnMissingOnce('回填');
    else console.warn(`[signal] 前瞻收益回填失败: ${err.message}`);
  } finally {
    running = false;
  }
}
