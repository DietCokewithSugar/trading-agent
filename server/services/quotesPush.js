import { getQuotes, getMarketSession, quoteDisplayFields } from './fmp.js';
import { listPoolPreview } from './candidateStore.js';
import { broadcast } from './bus.js';

/** 单次推送的符号数硬上限(持仓 15 + 池预览 10 远够;防御未来上游放宽) */
export const MAX_QUOTE_SYMBOLS = 40;
/** 池符号清单的进程内 TTL:免每 5s 查一次 DB;池变动本就伴随 macro 事件驱动前端整表重拉 */
const POOL_SYMBOLS_TTL_MS = 30_000;
/** 池符号报价容忍度(非休市):持仓价直接复用估值结果,只有池符号产生新请求 */
const POOL_QUOTE_MAX_AGE_MS = 10_000;
/**
 * 休市时段价格冻结,报价容忍度与整个推送节奏都放宽到 5 分钟
 * (周末盘外端点也只会返回周五盘后价),省 FMP 配额。
 * /api/pool 的休市容忍度也引用它,保持同一口径。
 */
export const CLOSED_QUOTE_MAX_AGE_MS = 5 * 60_000;

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
 * 估值持仓 → 报价映射(纯函数):持仓价直接取自本 tick 刚广播的估值结果,
 * 不再二次请求 FMP——保证同一 tick 的 portfolio 与 quotes 事件对同一持仓
 * 给出同一价格,也免去报价容忍度不一致的问题。
 * 报价缺失的持仓(live_quote=false,现价回退了成本价)跳过:成本价不能当实时价广播。
 */
export function positionsToQuotes(positions = []) {
  const map = new Map();
  for (const p of positions) {
    if (!p || p.live_quote === false) continue;
    const price = Number(p.current_price);
    if (!Number.isFinite(price) || price <= 0 || !p.symbol) continue;
    map.set(String(p.symbol).toUpperCase(), { effective_price: price, ...quoteDisplayFields(p) });
  }
  return map;
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
    const fields = quoteDisplayFields(q);
    quotes[String(symbol).toUpperCase()] = {
      effective_price: effective,
      ...fields,
      session: fields.session ?? session,
    };
    count += 1;
  }
  if (!count) return null;
  const ts = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return { ts, session, quotes };
}

// 进程内状态:池符号清单缓存 / 单飞旗标 / 休市限频 / 上次广播签名(内容去重)
let poolSymbolCache = { symbols: [], at: 0 };
let running = false;
let lastClosedRunAt = 0;
let lastSignature = null;

/** 清空进程内状态(管理后台数据重置时调用,避免继续为已清空的池符号取报价) */
export function clearQuotesPushState() {
  poolSymbolCache = { symbols: [], at: 0 };
  lastClosedRunAt = 0;
  lastSignature = null;
}

/**
 * 实时报价推送:随报价推送 tick 广播 SSE quotes 事件,覆盖「持仓 + 候选池 top」符号,
 * 前端(候选池表格/个股弹窗)据此实时合并现价与盘前盘后价——修复候选池在非常规时段
 * 现价冻结在旧收盘价、入池价漂移不实时的问题。
 * 调用方不 await(慢报价不能拖累 portfolio 推送节奏),用模块级单飞旗标防重入;
 * 纯观察层 fail-open:任何失败只 warn。
 */
export async function pushLiveQuotes(valuation) {
  if (running) return;
  running = true;
  try {
    const session = getMarketSession();
    // 休市:价格冻结,整轮推送限频到 5 分钟一次(时段切换后下一 tick 自动恢复节奏)
    if (session === 'closed') {
      if (Date.now() - lastClosedRunAt < CLOSED_QUOTE_MAX_AGE_MS) return;
      lastClosedRunAt = Date.now();
    }
    if (Date.now() - poolSymbolCache.at > POOL_SYMBOLS_TTL_MS) {
      // 池不可用(未启用宏观层/014 未迁移)时 listPoolPreview 返回 null → 退化为纯持仓推送
      const preview = await listPoolPreview(10).catch(() => null);
      poolSymbolCache = { symbols: (preview || []).map((c) => c.symbol), at: Date.now() };
    }
    const held = positionsToQuotes(valuation?.positions);
    const poolSymbols = collectQuoteSymbols({
      poolSymbols: poolSymbolCache.symbols,
      cap: Math.max(MAX_QUOTE_SYMBOLS - held.size, 0),
    }).filter((s) => !held.has(s));
    const fetched = poolSymbols.length
      ? await getQuotes(poolSymbols, session === 'closed' ? CLOSED_QUOTE_MAX_AGE_MS : POOL_QUOTE_MAX_AGE_MS)
      : new Map();
    const payload = buildQuotesPayload(new Map([...held, ...fetched]), { session });
    if (!payload) return;
    // 内容未变不重复广播(休市/横盘时省 SSE 流量与前端重渲染;ts 不参与比较)
    const signature = `${payload.session}|${JSON.stringify(payload.quotes)}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    broadcast('quotes', payload);
  } catch (err) {
    console.warn(`[quotes] 实时报价推送失败: ${err.message}`);
  } finally {
    running = false;
  }
}
