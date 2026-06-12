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
 *  - fwd_return_5d:信号日之后第 5 个交易日收盘价。
 * 列不存在(011 迁移未执行)时整体停用,主流程不受影响。
 */

const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
function etDate(iso) {
  return ET_DATE_FMT.format(new Date(iso));
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

let columnsMissing = false;
let running = false;

function isMissingColumn(error) {
  return /signal_price|fwd_return/.test(error?.message || '');
}

function warnMissingOnce(context) {
  if (columnsMissing) return;
  columnsMissing = true;
  console.warn(`[signal] news_analyses 缺少前瞻收益列,信号评估停用(请执行 011 迁移;${context})`);
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
 * 纯函数:由信号日之后的日线序列计算 1/5 个交易日前瞻收益(百分比)。
 * rows 为按日期升序的 [{ date: 'YYYY-MM-DD', price }];不足 N 个交易日返回 null。
 */
export function computeDailyForwardReturns({ rows, signalEtDate, signalPrice }) {
  const base = Number(signalPrice);
  if (!Number.isFinite(base) || base <= 0) return { r1d: null, r5d: null };
  const after = (rows || []).filter((r) => r.date > signalEtDate);
  const pct = (p) => round4((Number(p) / base - 1) * 100);
  return {
    r1d: after.length >= 1 ? pct(after[0].price) : null,
    r5d: after.length >= 5 ? pct(after[4].price) : null,
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

/** 1/5 个交易日口径:用日线收盘价回填(每只股票一次历史行情请求,缓存 1 小时) */
async function backfillDaily() {
  const now = Date.now();
  const todayEt = etDate(new Date().toISOString());
  const { data, error } = await supabase()
    .from('news_analyses')
    .select('id, symbol, signal_price, created_at, fwd_return_1d, fwd_return_5d')
    .not('signal_price', 'is', null)
    .or('fwd_return_1d.is.null,fwd_return_5d.is.null')
    .gte('created_at', new Date(now - 30 * 24 * 3600_000).toISOString())
    .lte('created_at', new Date(now - 24 * 3600_000).toISOString())
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  if (!data?.length) return 0;

  // 按股票分组,限制单轮历史行情请求数
  const bySymbol = new Map();
  for (const a of data) {
    const list = bySymbol.get(a.symbol) || [];
    list.push(a);
    bySymbol.set(a.symbol, list);
  }

  let filled = 0;
  let symbolBudget = 25;
  for (const [symbol, items] of bySymbol) {
    if (symbolBudget-- <= 0) break;
    const from = etDate(items[0].created_at);
    let rows;
    try {
      rows = await getHistoricalPrices(symbol, from, todayEt);
    } catch (err) {
      console.warn(`[signal] ${symbol} 历史行情获取失败,下轮重试: ${err.message}`);
      continue;
    }
    // FMP 日线端点在交易日盘中会返回当日(未收盘)的行,若拿它当"第 N 个交易日收盘"
    // 会把盘中价写死(回填只填 null、不再修正)。只采用日期早于今天的已定型 K 线,
    // 当日收盘留待下一轮回填——晚一天到账,但口径正确。
    const settledRows = (rows || []).filter((r) => r.date < todayEt);
    for (const a of items) {
      const { r1d, r5d } = computeDailyForwardReturns({
        rows: settledRows,
        signalEtDate: etDate(a.created_at),
        signalPrice: a.signal_price,
      });
      const update = {};
      if (a.fwd_return_1d === null && r1d !== null) update.fwd_return_1d = r1d;
      if (a.fwd_return_5d === null && r5d !== null) update.fwd_return_5d = r5d;
      if (!Object.keys(update).length) continue;
      const { error: updErr } = await supabase()
        .from('news_analyses')
        .update(update)
        .eq('id', a.id);
      if (updErr) throw updErr;
      filled += 1;
    }
  }
  return filled;
}

/** 由调度器周期调用(每 10 分钟):回填到期的前瞻收益 */
export async function backfillForwardReturns() {
  if (columnsMissing || running || isHalted()) return;
  running = true;
  try {
    const n1h = await backfill1h();
    const nDaily = await backfillDaily();
    if (n1h || nDaily) {
      console.log(`[signal] 前瞻收益回填: 1小时口径 ${n1h} 条,交易日口径 ${nDaily} 条`);
    }
  } catch (err) {
    if (isMissingColumn(err)) warnMissingOnce('回填');
    else console.warn(`[signal] 前瞻收益回填失败: ${err.message}`);
  } finally {
    running = false;
  }
}
