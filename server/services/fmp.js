import { config } from '../config.js';
import { isHoliday, isEarlyClose } from './marketCalendar.js';
import { recordProviderError } from './metrics.js';

const BASE = 'https://financialmodelingprep.com/stable';

async function fmpGet(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  url.searchParams.set('apikey', config.fmpApiKey);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`FMP ${path} 请求失败 ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  } catch (err) {
    // 供应商错误计数(HTTP 非 2xx 与网络/超时异常),原样抛出由调用方降级
    recordProviderError('fmp', err.message);
    throw err;
  }
}

/** 最新个股新闻(带 symbol) */
export async function getStockNews(limit = 40) {
  const data = await fmpGet('/news/stock-latest', { page: 0, limit });
  return Array.isArray(data) ? data : [];
}

/** 最新综合财经新闻 */
export async function getGeneralNews(limit = 20) {
  const data = await fmpGet('/news/general-latest', { page: 0, limit });
  return Array.isArray(data) ? data : [];
}

/** 最新公司公告/新闻稿 */
export async function getPressReleases(limit = 20) {
  const data = await fmpGet('/news/press-releases-latest', { page: 0, limit });
  return Array.isArray(data) ? data : [];
}

/**
 * 经济日历(CPI/FOMC/非农等定期数据,含 estimate/previous/actual 与发布时间)。
 * from/to 为 YYYY-MM-DD。部分 FMP 套餐不含该端点:403/404 时抛错由调用方判定停用。
 */
export async function getEconomicCalendar(from, to) {
  const data = await fmpGet('/economic-calendar', { from, to });
  return Array.isArray(data) ? data : [];
}

/**
 * 当前美股市场时段(美东时间):
 * pre 盘前 4:00–9:30 / regular 盘中 9:30–16:00 / post 盘后 16:00–20:00 / closed 休市。
 * 周末与交易所假日(marketCalendar.js 规则计算)直接 closed;
 * 半日市(7/3、感恩节次日、12/24)盘中 9:30–13:00,盘后 13:00–17:00。
 */
export function getMarketSession(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return 'closed';
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
  if (isHoliday(dateStr)) return 'closed';
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  const regularEnd = isEarlyClose(dateStr) ? 780 : 960; // 半日市 13:00 收盘
  const postEnd = isEarlyClose(dateStr) ? 1020 : 1200; // 半日市盘后至 17:00
  if (minutes >= 240 && minutes < 570) return 'pre';
  if (minutes >= 570 && minutes < regularEnd) return 'regular';
  if (minutes >= regularEnd && minutes < postEnd) return 'post';
  return 'closed';
}

/** FMP 返回的时间戳有秒/毫秒两种,统一为毫秒(trader 记录成交报价时间戳也用它) */
export function normalizeTs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n : n * 1000;
}

/** 盘前盘后最新成交价。订阅无此端点或失败时返回 null,自动退回收盘价 */
async function getAftermarketTrade(symbol) {
  try {
    const data = await fmpGet('/aftermarket-trade', { symbol });
    const t = Array.isArray(data) ? data[0] : data;
    if (!t || typeof t.price !== 'number' || t.price <= 0) return null;
    return t;
  } catch {
    return null;
  }
}

/** 公司档案缓存:名称/行业/上市状态等变化极慢,缓存 24 小时 */
const profileCache = new Map(); // symbol -> { profile, at }

/**
 * 公司档案(companyName / sector / industry / marketCap / ipoDate /
 * isActivelyTrading / range / averageVolume 等)。
 * 交易前用于核验"新闻主体公司"与"报价对应公司"是否一致,失败返回 null。
 */
export async function getProfile(symbol, maxAgeMs = 24 * 3600_000) {
  const key = symbol.toUpperCase();
  const cached = profileCache.get(key);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.profile;
  try {
    const data = await fmpGet('/profile', { symbol: key });
    const p = Array.isArray(data) ? data[0] : data;
    const profile = p && (p.companyName || p.symbol) ? p : null;
    profileCache.set(key, { profile, at: Date.now() });
    return profile;
  } catch (err) {
    console.warn(`[fmp] 获取 ${key} 公司档案失败: ${err.message}`);
    return null;
  }
}

/** 报价缓存:高频请求时避免重复打 FMP */
const quoteCache = new Map(); // symbol -> { quote, at }

/**
 * 单只股票实时报价。maxAgeMs 控制可接受的缓存时长。
 * 非盘中时段会合并盘前/盘后成交价,返回字段:
 *  - effective_price: 估值与模拟成交使用的最新有效价格
 *  - extended_price / extended_change_percent: 盘前盘后价及相对收盘价的涨跌幅
 *  - session: 当前市场时段
 */
export async function getQuote(symbol, maxAgeMs = 10_000) {
  const key = symbol.toUpperCase();
  const cached = quoteCache.get(key);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.quote;

  const session = getMarketSession();
  const [quoteData, extTrade] = await Promise.all([
    fmpGet('/quote', { symbol: key }),
    session !== 'regular' ? getAftermarketTrade(key) : Promise.resolve(null),
  ]);
  const q = Array.isArray(quoteData) ? quoteData[0] : quoteData;
  if (!q || typeof q.price !== 'number') return null;

  q.session = session;
  q.effective_price = q.price;
  q.extended_price = null;
  q.extended_change_percent = null;

  if (extTrade) {
    const quoteTs = normalizeTs(q.timestamp);
    const extTs = normalizeTs(extTrade.timestamp);
    // 盘前盘后成交比常规报价更新时才采用(防止用上一交易日的旧盘后价覆盖今日收盘价);
    // 盘后价自身无时间戳时新旧无从判断,不采用(fail-closed,退回常规报价)
    if (extTs && (!quoteTs || extTs >= quoteTs)) {
      q.extended_price = extTrade.price;
      q.effective_price = extTrade.price;
      q.extended_change_percent = ((extTrade.price - q.price) / q.price) * 100;
    }
  }

  quoteCache.set(key, { quote: q, at: Date.now() });
  return q;
}

/** 历史日线缓存:日线收盘价当天内不变,缓存 1 小时足够 */
const historyCache = new Map(); // symbol:from:to -> { rows, at }

/**
 * 历史日线收盘价(轻量端点),用于业绩基准对比。
 * from/to 为 YYYY-MM-DD;返回按日期升序的 [{ date, price, volume }]。
 */
export async function getHistoricalPrices(symbol, from, to, maxAgeMs = 3600_000) {
  const key = `${symbol.toUpperCase()}:${from}:${to}`;
  const cached = historyCache.get(key);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.rows;

  const data = await fmpGet('/historical-price-eod/light', {
    symbol: symbol.toUpperCase(),
    from,
    to,
  });
  const rows = (Array.isArray(data) ? data : [])
    .filter((r) => r && r.date && typeof r.price === 'number')
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  historyCache.set(key, { rows, at: Date.now() });
  return rows;
}

/**
 * 股息调整后的历史日线(总回报口径,股息再投资),用于 SPY 基准——
 * 纯价格序列会漏掉约 1.3% 的年化股息,凭空送策略超额收益。
 * 返回 { rows: [{ date, price, volume }], adjusted };端点失败时
 * 回退到未调整的 light 端点并标记 adjusted=false。
 */
export async function getHistoricalPricesAdjusted(symbol, from, to, maxAgeMs = 3600_000) {
  const key = `${symbol.toUpperCase()}:${from}:${to}:adj`;
  const cached = historyCache.get(key);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.rows;

  let result;
  try {
    const data = await fmpGet('/historical-price-eod/dividend-adjusted', {
      symbol: symbol.toUpperCase(),
      from,
      to,
    });
    const rows = (Array.isArray(data) ? data : [])
      .filter((r) => r && r.date && typeof r.adjClose === 'number')
      .map((r) => ({ date: r.date, price: r.adjClose, volume: r.volume }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!rows.length) throw new Error('股息调整端点返回为空');
    result = { rows, adjusted: true };
  } catch (err) {
    console.warn(`[fmp] ${symbol} 股息调整历史价不可用(${err.message}),回退未调整价格`);
    result = { rows: await getHistoricalPrices(symbol, from, to, maxAgeMs), adjusted: false };
  }
  historyCache.set(key, { rows: result, at: Date.now() });
  return result;
}

/** 清空进程内缓存(管理后台数据重置时调用,确保重置后拿到的都是新数据) */
export function clearCaches() {
  quoteCache.clear();
  profileCache.clear();
  historyCache.clear();
}

/** 批量报价,返回 Map<symbol, quote> */
export async function getQuotes(symbols, maxAgeMs = 10_000) {
  const unique = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const map = new Map();
  await Promise.all(
    unique.map(async (s) => {
      try {
        const q = await getQuote(s, maxAgeMs);
        if (q) map.set(s, q);
      } catch (err) {
        console.warn(`[fmp] 获取 ${s} 报价失败: ${err.message}`);
      }
    })
  );
  return map;
}
