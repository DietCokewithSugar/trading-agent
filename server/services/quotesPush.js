import { getQuotes, getMarketSession } from './fmp.js';
import { listPoolPreview } from './candidateStore.js';
import { broadcast } from './bus.js';

/** 单次推送的符号数硬上限(持仓 15 + 池预览 10 远够;防御未来上游放宽) */
export const MAX_QUOTE_SYMBOLS = 40;
/** 池符号清单的进程内 TTL:免每 5s 查一次 DB;池变动本就伴随 macro 事件驱动前端整表重拉 */
const POOL_SYMBOLS_TTL_MS = 30_000;
/** 非休市时段报价容忍度:持仓符号已被估值推送灌热缓存,实际只有池符号产生新请求 */
const POOL_QUOTE_MAX_AGE_MS = 10_000;
/** 休市时段价格冻结,放宽到 5 分钟(周末盘外端点也只会返回周五盘后价),省 FMP 配额 */
const CLOSED_QUOTE_MAX_AGE_MS = 5 * 60_000;

/**
 * 合并去重报价符号(纯函数):统一大写,持仓优先于候选池,截断到 cap。
 * 持仓优先是因为其报价直接决定估值/止损展示,候选池只是参考价。
 */
export function collectQuoteSymbols({ heldSymbols = [], poolSymbols = [], cap = MAX_QUOTE_SYMBOLS } = {}) {
  const seen = new Set();
  const out = [];
  for (const s of [...heldSymbols, ...poolSymbols]) {
    const key = String(s || '').trim().toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * 报价 Map → SSE quotes 事件载荷(纯函数)。
 * 每条只保留前端展示需要的字段;effective_price 非有限或 ≤0 的整条剔除
 * (残缺价格宁可让前端保留旧值,也不能推下去污染现价/漂移)。
 * 全部无效时返回 null(调用方跳过广播)。
 */
export function buildQuotesPayload(quotesMap, { session = null, now = new Date() } = {}) {
  const quotes = {};
  let count = 0;
  for (const [symbol, q] of quotesMap instanceof Map ? quotesMap : new Map()) {
    if (!q) continue;
    const effective = Number(q.effective_price ?? q.price);
    if (!Number.isFinite(effective) || effective <= 0) continue;
    const price = Number(q.price);
    // 上游字段名不稳定(changesPercentage/changePercentage),与 portfolio.js 同款双字段兜底
    const chg = Number(q.changesPercentage ?? q.changePercentage);
    quotes[String(symbol).toUpperCase()] = {
      price: Number.isFinite(price) && price > 0 ? price : null,
      effective_price: effective,
      extended_price: q.extended_price ?? null,
      extended_change_percent: q.extended_change_percent ?? null,
      change_percent: Number.isFinite(chg) ? chg : null,
      session: q.session ?? session,
    };
    count += 1;
  }
  if (!count) return null;
  const ts = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return { ts, session, quotes };
}

// 池符号清单缓存(进程内):{ symbols, at }
let poolSymbolCache = { symbols: [], at: 0 };

/** 测试/管理重置用:清空池符号缓存 */
export function clearPoolSymbolCache() {
  poolSymbolCache = { symbols: [], at: 0 };
}

/**
 * 实时报价推送:随报价推送 tick 广播 SSE quotes 事件,覆盖「持仓 + 候选池 top」符号,
 * 前端(候选池表格/个股弹窗)据此实时合并现价与盘前盘后价——修复候选池在非常规时段
 * 现价冻结在旧收盘价、入池价漂移不实时的问题。
 * 纯观察层,fail-open:任何失败只 warn,绝不影响既有 portfolio 推送。
 */
export async function pushLiveQuotes(valuation) {
  try {
    const session = getMarketSession();
    if (Date.now() - poolSymbolCache.at > POOL_SYMBOLS_TTL_MS) {
      // 池不可用(未启用宏观层/014 未迁移)时 listPoolPreview 返回 null → 退化为纯持仓推送
      const preview = await listPoolPreview(10).catch(() => null);
      poolSymbolCache = { symbols: (preview || []).map((c) => c.symbol), at: Date.now() };
    }
    const symbols = collectQuoteSymbols({
      heldSymbols: (valuation?.positions || []).map((p) => p.symbol),
      poolSymbols: poolSymbolCache.symbols,
    });
    if (!symbols.length) return;
    // 休市时价格冻结,用长容忍度避免无谓请求;时段切换后下一 tick 自动恢复节奏
    const maxAge = session === 'closed' ? CLOSED_QUOTE_MAX_AGE_MS : POOL_QUOTE_MAX_AGE_MS;
    const payload = buildQuotesPayload(await getQuotes(symbols, maxAge), { session });
    if (payload) broadcast('quotes', payload);
  } catch (err) {
    console.warn(`[quotes] 实时报价推送失败: ${err.message}`);
  }
}
