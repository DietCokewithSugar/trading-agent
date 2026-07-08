import { XMLParser } from 'fast-xml-parser';
import { config } from '../config.js';
import { supabase } from '../db.js';

/**
 * SEC EDGAR 监管文件源(026,日志前缀 [sec])。
 *
 * 最高可信事件源:官方接口免密钥,仅按公平访问政策申明 User-Agent(≤10 req/s)。
 * 发现走全市场"最新提交"Atom 流(getcurrent,近实时),CIK→ticker 映射
 * (company_tickers_exchange.json,24h 缓存)过滤掉基金/私有主体,再对每份新 filing
 * 抓取主文档提取正文与 8-K 事项条目编码;非重大条目(白名单外)的例行披露直接丢弃。
 *
 * 失败分层与 FMP/Yahoo 约定一致:整源失败(feed/映射)向上抛,由 fetchAndStoreNews
 * 的 Promise.allSettled 记入 summary.errors;单份 filing 失败仅 warn 并跳过,
 * 且不标记已见——留在 feed 窗口内下轮自动重试(只有标题的元数据文章以 1.00
 * 可信度进 LLM 管线,比晚 5 分钟更糟)。
 *
 * getcurrent 属 SEC 长期稳定的 legacy 接口;若未来下线,迁移路径是
 * data.sec.gov/submissions/CIK##########.json(结构化 JSON,含 items 字段,
 * 但为按公司轮询,需要另做全市场发现)。
 */

// Atom 的 <link href>/<category term> 是属性,必须保留属性解析
//(yahoo.js 的 ignoreAttributes: true 配置解析不了)
const atomParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const SEC_CURRENT_FEED_URL =
  'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&count=100&output=atom';
const SEC_TICKER_MAP_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';

// ── 纯函数(可单测,无 IO)──

/**
 * 解析 getcurrent Atom 流,返回 [{ formType, company, cik, accession, indexUrl, filedAt }]。
 * entry 标题形如 "8-K - Apple Inc. (0000320193) (Filer)",id 携带 accession number,
 * link 指向 filing 的 -index.htm 页面,updated 是带时区的受理时间戳。
 */
export function parseAtomEntries(xml) {
  let doc;
  try {
    doc = atomParser.parse(String(xml ?? ''));
  } catch {
    return [];
  }
  let entries = doc?.feed?.entry ?? [];
  if (!Array.isArray(entries)) entries = [entries];
  const out = [];
  for (const e of entries) {
    if (!e) continue;
    const title = String(e.title ?? '');
    const tm = /^(.+?) - (.+?) \((\d{10})\)/.exec(title);
    const formType = String(e.category?.['@_term'] ?? (tm ? tm[1] : '')).trim();
    const company = tm ? tm[2].trim() : '';
    const cik = tm ? Number(tm[3]) : null;
    const am = /accession-number=(\d{10}-\d{2}-\d{6})/.exec(String(e.id ?? ''));
    const accession = am ? am[1] : null;
    let link = e.link;
    if (Array.isArray(link)) link = link[0];
    const indexUrl = link?.['@_href'] ? String(link['@_href']) : null;
    let filedAt = null;
    if (e.updated) {
      const d = new Date(e.updated);
      if (!Number.isNaN(d.getTime())) filedAt = d.toISOString();
    }
    if (!formType || !company || !cik || !accession || !indexUrl) continue;
    out.push({ formType, company, cik, accession, indexUrl, filedAt });
  }
  return out;
}

/**
 * 解析 company_tickers_exchange.json({ fields, data } 列存形状)为 Map<cik, {ticker, exchange, name}>。
 * 同一 CIK 多行(多股份类别)取首行——SEC 把主类放在前(GOOGL 先于 GOOG);
 * ticker 统一大写并把 "." 归一为 "-"(BRK.B → BRK-B,与 FMP 报价符号一致);
 * 无 ticker/exchange 的行(未上市主体)丢弃。
 */
export function parseCikTickerMap(json) {
  const map = new Map();
  const fields = Array.isArray(json?.fields) ? json.fields : [];
  const rows = Array.isArray(json?.data) ? json.data : [];
  const col = {
    cik: fields.indexOf('cik'),
    name: fields.indexOf('name'),
    ticker: fields.indexOf('ticker'),
    exchange: fields.indexOf('exchange'),
  };
  if (col.cik < 0 || col.ticker < 0) return map;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const cik = Number(row[col.cik]);
    const ticker = String(row[col.ticker] ?? '').trim().toUpperCase().replace(/\./g, '-');
    const exchange = col.exchange >= 0 ? String(row[col.exchange] ?? '').trim() : '';
    const name = col.name >= 0 ? String(row[col.name] ?? '').trim() : '';
    if (!Number.isFinite(cik) || !cik || !ticker || !exchange) continue;
    if (!map.has(cik)) map.set(cik, { ticker, exchange, name });
  }
  return map;
}

/** filing 的 -index.htm 链接 → 该 filing 的目录 URL(去掉最后一段文件名) */
export function filingDirUrl(indexUrl) {
  return String(indexUrl ?? '').replace(/\/[^/]*$/, '');
}

/**
 * 从 filing 目录的 index.json 条目里挑主文档(文件名启发式,非 submissions API
 * 的权威 primaryDocument 字段——选错只降级为较弱正文,不会错 ticker):
 * 优先名字含 8-K 的 html,其次任意非索引/非裸提交/非 XBRL 报表页/非附件的 html,
 * 再放宽允许附件(ex99 往往是随附新闻稿),兜底首个 txt。
 */
export function choosePrimaryDoc(items) {
  const names = (Array.isArray(items) ? items : [])
    .map((it) => String(it?.name ?? ''))
    .filter(Boolean);
  const isHtml = (n) => /\.html?$/i.test(n);
  const isNoise = (n) =>
    /-index\.html?$/i.test(n) || /^\d{10}-\d{2}-\d{6}/.test(n) || /^R\d+\.htm/i.test(n);
  const html = names.filter((n) => isHtml(n) && !isNoise(n));
  return (
    html.find((n) => /8-?k/i.test(n)) ||
    html.find((n) => !/^ex|_ex|-ex/i.test(n)) ||
    html[0] ||
    names.find((n) => /\.txt$/i.test(n)) ||
    null
  );
}

/** 剥 HTML 为纯文本:去 script/style 块、剥标签(含 inline-XBRL ix: 标签)、解码常用实体、折叠空白 */
export function stripHtml(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从正文提取 8-K 事项条目编码(去重、按数值排序;"Item 5.02(b)" → '5.02') */
export function extractItemCodes(text) {
  const found = new Set();
  const re = /Item\s+(\d+\.\d{2})/gi;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) found.add(m[1]);
  return [...found].sort((a, b) => parseFloat(a) - parseFloat(b));
}

/** 8-K 重大事项条目的简短英文标签(标题/元数据头展示用,非全集) */
export const ITEM_LABELS = {
  '1.01': 'Material Agreement',
  '1.02': 'Termination of Agreement',
  '1.03': 'Bankruptcy',
  '2.01': 'Acquisition or Disposition',
  '2.02': 'Results of Operations',
  '2.03': 'Financial Obligation',
  '2.04': 'Obligation Acceleration',
  '2.05': 'Exit or Disposal Costs',
  '2.06': 'Material Impairments',
  '3.01': 'Delisting Notice',
  '3.02': 'Unregistered Equity Sales',
  '3.03': 'Holder Rights Modification',
  '4.01': 'Auditor Change',
  '4.02': 'Non-Reliance on Financials',
  '5.01': 'Change in Control',
  '5.02': 'Officer or Director Changes',
  '5.03': 'Charter or Bylaws Amendment',
  '5.07': 'Shareholder Vote',
  '7.01': 'Reg FD Disclosure',
  '8.01': 'Other Events',
  '9.01': 'Exhibits',
};

/**
 * 白名单门:条目命中重大事项白名单才进分析管线。
 * 空 items = 正文解析失败而非事件不重大 → fail-open 放行(真实 8-K 必有条目);
 * 空白名单 = 显式配置不过滤,全部放行。
 */
export function hasWhitelistedItem(items, whitelist) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return true;
  const allow = new Set(whitelist ?? []);
  if (!allow.size) return true;
  return list.some((code) => allow.has(code));
}

/** 文章标题:`8-K: Apple Inc. — Item 2.02, 9.01 (Results of Operations; Exhibits)` */
export function buildFilingTitle({ formType = '8-K', company = '', items = [] }) {
  const codes = items.length ? ` — Item ${items.join(', ')}` : '';
  const labels = items.map((c) => ITEM_LABELS[c]).filter(Boolean);
  const suffix = labels.length ? ` (${labels.join('; ')})` : '';
  return `${formType}: ${company}${codes}${suffix}`;
}

/** 正文元数据头:`[SEC Form 8-K | Items: 2.02 Results of Operations, 9.01 Exhibits]`(分析师提示词有对应说明) */
export function buildMetadataHeader({ formType = '8-K', items = [] }) {
  const parts = items.map((c) => (ITEM_LABELS[c] ? `${c} ${ITEM_LABELS[c]}` : c));
  return `[SEC Form ${formType}${parts.length ? ` | Items: ${parts.join(', ')}` : ''}]`;
}

/** 从已入库的主文档 URL 反推 accession number(已见集合预热用),18 位目录段 → 带连字符格式 */
export function parseAccessionFromUrl(url) {
  const m = /\/(\d{18})\//.exec(String(url ?? ''));
  if (!m) return null;
  const d = m[1];
  return `${d.slice(0, 10)}-${d.slice(10, 12)}-${d.slice(12)}`;
}

// ── IO 层 ──

async function secFetch(url, { timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': config.secUserAgent },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`SEC 请求失败 ${res.status}: ${String(url).slice(0, 120)}`);
  }
  return res;
}

// CIK→ticker 映射:外部市场数据,24h 缓存;刷新失败沿用旧表并 1 小时后重试
const TICKER_MAP_TTL_MS = 24 * 3600_000;
const TICKER_MAP_RETRY_MS = 3600_000;
let tickerMapCache = { map: null, at: 0 };

async function getCikTickerMap() {
  if (tickerMapCache.map && Date.now() - tickerMapCache.at < TICKER_MAP_TTL_MS) {
    return tickerMapCache.map;
  }
  try {
    const res = await secFetch(SEC_TICKER_MAP_URL);
    const map = parseCikTickerMap(await res.json());
    if (!map.size) throw new Error('CIK→ticker 映射为空');
    tickerMapCache = { map, at: Date.now() };
    return map;
  } catch (err) {
    if (tickerMapCache.map) {
      console.warn(`[sec] CIK→ticker 映射刷新失败,沿用旧表: ${err.message}`);
      tickerMapCache.at = Date.now() - TICKER_MAP_TTL_MS + TICKER_MAP_RETRY_MS;
      return tickerMapCache.map;
    }
    throw new Error(`SEC CIK→ticker 映射不可用: ${err.message}`);
  }
}

// 已见 accession 集合(插入序,LRU 上限):避免同一 filing 反复抓正文。
// 跨重启由 DB 的 onConflict:'url' 兜底防重复入库,这里只省子请求
const SEEN_CAP = 2000;
let seenAccessions = new Set();
let seenWarmed = false;

function markSeen(accession) {
  if (seenAccessions.has(accession)) return;
  seenAccessions.add(accession);
  if (seenAccessions.size > SEEN_CAP) {
    seenAccessions.delete(seenAccessions.values().next().value);
  }
}

/** 进程首轮从库里最近的 sec-filings 文章反推 accession,防止重启后重抓正文(失败 fail-open 空集合) */
async function warmSeenAccessions() {
  if (seenWarmed) return;
  seenWarmed = true;
  try {
    const { data, error } = await supabase()
      .from('news_articles')
      .select('url')
      .eq('source', 'sec-filings')
      .order('fetched_at', { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    for (const row of data || []) {
      const acc = parseAccessionFromUrl(row.url);
      if (acc) seenAccessions.add(acc);
    }
    if (seenAccessions.size) console.log(`[sec] 已见集合预热 ${seenAccessions.size} 条`);
  } catch (err) {
    console.warn(`[sec] 已见集合预热失败(继续空集合): ${err.message}`);
  }
}

/** 小并发映射:尊重 SEC 限频,单份失败不影响其余 */
async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  });
  await Promise.all(workers);
}

/** 抓单份 filing 的正文并组装文章条目;非白名单条目返回 null(标记已见丢弃) */
async function fetchFilingArticle(f) {
  const dir = filingDirUrl(f.indexUrl);
  const idxRes = await secFetch(`${dir}/index.json`);
  const idx = await idxRes.json();
  const docName = choosePrimaryDoc(idx?.directory?.item);
  if (!docName) throw new Error('目录中未找到主文档');
  const docUrl = `${dir}/${docName}`;
  const docRes = await secFetch(docUrl);
  const text = stripHtml(await docRes.text());
  const items = extractItemCodes(text);
  if (!hasWhitelistedItem(items, config.sec8kItemWhitelist)) {
    markSeen(f.accession); // 例行披露(章程修订/Reg FD 等):记住并丢弃,不入库不进 LLM
    return null;
  }
  markSeen(f.accession);
  return {
    url: docUrl, // 主文档链接:稳定唯一,news_articles 的 onConflict 去重键
    title: buildFilingTitle({ formType: f.formType, company: f.company, items }),
    textContent: `${buildMetadataHeader({ formType: f.formType, items })} ${text}`.slice(0, 4000),
    symbol: f.ticker,
    companyName: f.company,
    cik: f.cik,
    accession: f.accession,
    formType: f.formType,
    items,
    filedAt: f.filedAt,
  };
}

/**
 * 主入口:拉最新 8-K 流,过滤已见/无 ticker 主体,抓正文产出规范化条目。
 * 整源失败(feed/映射)向上抛;单份失败 warn 并留待下轮重试。
 */
export async function getSecFilings({ max = config.secMaxFilingsPerPoll } = {}) {
  await warmSeenAccessions();
  const tickerMap = await getCikTickerMap();

  const feedRes = await secFetch(SEC_CURRENT_FEED_URL);
  const entries = parseAtomEntries(await feedRes.text());

  const hadSeen = seenAccessions.size > 0;
  let seenHits = 0;
  const fresh = [];
  for (const entry of entries) {
    if (!entry.formType.toUpperCase().startsWith('8-K')) continue;
    if (seenAccessions.has(entry.accession)) {
      seenHits += 1;
      continue;
    }
    const listing = tickerMap.get(entry.cik);
    if (!listing) {
      markSeen(entry.accession); // 基金/私有主体:无上市 ticker,记住并跳过
      continue;
    }
    if (fresh.some((x) => x.accession === entry.accession)) continue; // 同 filing 多 filer 只取一条
    fresh.push({ ...entry, ...listing });
  }
  // 已有历史的进程里整页全为未见 → feed 窗口可能已滚动,提示存在漏抓风险
  if (hadSeen && entries.length >= 90 && seenHits === 0) {
    console.warn(`[sec] 单轮 ${entries.length} 条 8-K 全为未见,feed 窗口可能滚动漏抓`);
  }

  const targets = fresh.slice(0, max); // feed 新的在前:洪峰时优先最新(时效分本就更高)
  const out = [];
  await mapLimit(targets, 4, async (f) => {
    try {
      const item = await fetchFilingArticle(f);
      if (item) out.push(item);
    } catch (err) {
      // 不标记已见:留在 feed 窗口内,下轮自动重试(D4)
      console.warn(`[sec] ${f.ticker} ${f.accession} 正文抓取失败(下轮重试): ${err.message}`);
    }
  });
  if (out.length) console.log(`[sec] 新增 ${out.length} 份 8-K(候选 ${fresh.length} 份)`);
  return out;
}

/** 管理员重置:清已见集合(库已清空需可重灌);ticker 映射是外部市场数据,保留(经济日历缓存同款先例) */
export function clearSecFilingsState() {
  seenAccessions = new Set();
  seenWarmed = false;
}
