import { config } from '../config.js';

const BASE = 'https://financialmodelingprep.com/stable';

async function fmpGet(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  url.searchParams.set('apikey', config.fmpApiKey);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`FMP ${path} 请求失败 ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
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
 * 当前美股市场时段(美东时间):
 * pre 盘前 4:00–9:30 / regular 盘中 9:30–16:00 / post 盘后 16:00–20:00 / closed 休市
 * 注:不含交易所假日判断,假日会被视为对应时段,但价格不变、无害。
 */
export function getMarketSession(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return 'closed';
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  if (minutes >= 240 && minutes < 570) return 'pre';
  if (minutes >= 570 && minutes < 960) return 'regular';
  if (minutes >= 960 && minutes < 1200) return 'post';
  return 'closed';
}

/** FMP 返回的时间戳有秒/毫秒两种,统一为毫秒 */
function normalizeTs(ts) {
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
    // 盘前盘后成交比常规报价更新时才采用(防止用上一交易日的旧盘后价覆盖今日收盘价)
    if (!quoteTs || !extTs || extTs >= quoteTs) {
      q.extended_price = extTrade.price;
      q.effective_price = extTrade.price;
      q.extended_change_percent = ((extTrade.price - q.price) / q.price) * 100;
    }
  }

  quoteCache.set(key, { quote: q, at: Date.now() });
  return q;
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
