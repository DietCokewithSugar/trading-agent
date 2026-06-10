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

/** 报价缓存:前端高频刷新时避免重复请求 FMP */
const quoteCache = new Map(); // symbol -> { quote, at }
const QUOTE_TTL_MS = 10_000;

/** 单只股票实时报价(带 10 秒缓存) */
export async function getQuote(symbol) {
  const key = symbol.toUpperCase();
  const cached = quoteCache.get(key);
  if (cached && Date.now() - cached.at < QUOTE_TTL_MS) return cached.quote;

  const data = await fmpGet('/quote', { symbol: key });
  const q = Array.isArray(data) ? data[0] : data;
  if (!q || typeof q.price !== 'number') return null;
  quoteCache.set(key, { quote: q, at: Date.now() });
  return q;
}

/** 批量报价,返回 Map<symbol, quote> */
export async function getQuotes(symbols) {
  const unique = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const map = new Map();
  await Promise.all(
    unique.map(async (s) => {
      try {
        const q = await getQuote(s);
        if (q) map.set(s, q);
      } catch (err) {
        console.warn(`[fmp] 获取 ${s} 报价失败: ${err.message}`);
      }
    })
  );
  return map;
}
