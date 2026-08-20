import { signalStrength } from './conflictResolver.js';

/**
 * 板块分类(SPDR 行业 ETF 口径)——把数据源给出的行业字符串(公司档案的
 * profile.sector、宏观事件的 affected_sectors)归一到 11 个 SPDR 精选行业 ETF
 * (XLK/XLV/XLF/…),新闻按板块筛选与"板块整体利好/利空"都以此为准。
 *
 * 设计约定:库里存的仍是**数据源原始行业名**(与 candidate_signals.sector 同口径),
 * 归一只发生在代码里 —— 数据源改名或新增别名时改这里的别名表即可,历史数据不用迁移。
 *
 * 纯函数模块(无 IO,可直接单测);取数/落库在 sectorService.js。
 */

/**
 * 11 个 SPDR 精选行业板块。
 *  - key/etf: 对应的行业 ETF 代码(用户口径:XLV/XLC/XLE/XLF/XLRE/XLK…)
 *  - name:    数据源标准行业名(deepseek.js#FMP_SECTORS 同一份口径,写库/宏观匹配用)
 *  - label:   中文名(前端展示)
 *  - aliases: 同一板块的其他常见叫法(GICS 名、数据源历史分类)
 * 顺序即前端看板的展示顺序(大致按美股市值权重)。
 */
export const SECTORS = [
  {
    key: 'XLK',
    name: 'Technology',
    label: '科技',
    aliases: ['Information Technology', 'Tech'],
  },
  {
    key: 'XLV',
    name: 'Healthcare',
    label: '医疗保健',
    aliases: ['Health Care', 'Healthcare Services', 'Medical'],
  },
  {
    key: 'XLF',
    name: 'Financial Services',
    label: '金融',
    aliases: ['Financials', 'Financial'],
  },
  {
    key: 'XLY',
    name: 'Consumer Cyclical',
    label: '可选消费',
    aliases: ['Consumer Discretionary', 'Consumer Goods'],
  },
  {
    key: 'XLC',
    name: 'Communication Services',
    label: '通信服务',
    aliases: ['Communication', 'Telecommunication Services', 'Telecom'],
  },
  {
    key: 'XLI',
    name: 'Industrials',
    label: '工业',
    aliases: ['Industrial Goods', 'Industrial'],
  },
  {
    key: 'XLP',
    name: 'Consumer Defensive',
    label: '必需消费',
    aliases: ['Consumer Staples'],
  },
  { key: 'XLE', name: 'Energy', label: '能源', aliases: ['Oil & Gas'] },
  { key: 'XLU', name: 'Utilities', label: '公用事业', aliases: [] },
  { key: 'XLRE', name: 'Real Estate', label: '房地产', aliases: ['Realestate'] },
  {
    key: 'XLB',
    name: 'Basic Materials',
    label: '原材料',
    aliases: ['Materials', 'Basic Material'],
  },
];

/** 无法归类(数据源缺行业名、或给了表外的新分类)的兜底桶 */
export const UNCLASSIFIED = 'OTHER';
export const UNCLASSIFIED_LABEL = '未分类';

export const SECTOR_KEYS = SECTORS.map((s) => s.key);

const BY_KEY = new Map(SECTORS.map((s) => [s.key, s]));

/** 别名比较用的折叠形式:忽略大小写与空格/连字符/斜杠("Health Care" ≡ "Healthcare") */
function fold(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s_\-&/.]+/g, '');
}

const ALIAS_TO_KEY = new Map();
for (const s of SECTORS) {
  for (const name of [s.key, s.name, s.label, ...s.aliases]) ALIAS_TO_KEY.set(fold(name), s.key);
}

/**
 * 任意行业字符串 → 板块 key(ETF 代码);无法归类返回 null。
 * 接受数据源行业名、GICS 名、中文名与 ETF 代码本身(前端筛选参数直接复用)。
 */
export function normalizeSector(raw) {
  if (raw === null || raw === undefined) return null;
  const folded = fold(raw);
  if (!folded) return null;
  return ALIAS_TO_KEY.get(folded) ?? null;
}

/** 板块元信息(key/etf/name/label);未知 key 返回 null */
export function sectorMeta(key) {
  const s = BY_KEY.get(String(key || '').toUpperCase());
  return s ? { key: s.key, etf: s.key, name: s.name, label: s.label } : null;
}

/**
 * 该板块在库里可能出现的原始行业名(标准名 + 别名,保持原始大小写)。
 * 数据库端按板块筛选用 .in() 匹配这组字符串 —— 库里存的是数据源原文。
 */
export function sectorProviderNames(key) {
  const s = BY_KEY.get(String(key || '').toUpperCase());
  return s ? [s.name, ...s.aliases] : [];
}

/** 净情绪分:(利好权重 − 利空权重)/ 总权重 ∈ [-1, 1];无非中性样本返回 null */
export function netSentimentScore(bullishWeight, bearishWeight) {
  const bull = Number(bullishWeight) || 0;
  const bear = Number(bearishWeight) || 0;
  const total = bull + bear;
  if (total <= 0) return null;
  return Number(((bull - bear) / total).toFixed(3));
}

function emptyBucket(key) {
  const meta = sectorMeta(key);
  return {
    key,
    etf: meta ? meta.etf : null,
    name: meta ? meta.name : null,
    label: meta ? meta.label : UNCLASSIFIED_LABEL,
    bullish: 0,
    bearish: 0,
    neutral: 0,
    total: 0,
    bullish_weight: 0,
    bearish_weight: 0,
    score: null,
    symbols: [],
  };
}

function finalizeBucket(bucket, symbolMap, topSymbols) {
  bucket.bullish_weight = Number(bucket.bullish_weight.toFixed(3));
  bucket.bearish_weight = Number(bucket.bearish_weight.toFixed(3));
  bucket.score = netSentimentScore(bucket.bullish_weight, bucket.bearish_weight);
  bucket.symbols = [...symbolMap.values()]
    .map((s) => ({
      symbol: s.symbol,
      bullish: s.bullish,
      bearish: s.bearish,
      neutral: s.neutral,
      total: s.total,
      score: netSentimentScore(s.bullish_weight, s.bearish_weight),
    }))
    // 先按有方向的信号条数,再按情绪强度,最后按代码字典序(排序稳定,便于比对)
    .sort(
      (a, b) =>
        b.bullish + b.bearish - (a.bullish + a.bearish) ||
        Math.abs(b.score ?? 0) - Math.abs(a.score ?? 0) ||
        a.symbol.localeCompare(b.symbol)
    )
    .slice(0, topSymbols);
  return bucket;
}

/**
 * 按板块汇总一批分析行的整体利好/利空。
 *
 * 每条信号的权重 = 综合置信度(缺失回退分析置信度,再缺失按 0.5 保守计)× 档位分,
 * 与候选池打分/冲突裁决同一口径(conflictResolver.signalStrength)——
 * 一档高置信的利好不会被一堆四档噪声淹没。中性信号只计数、不进分子分母。
 *
 * 返回固定 11 个板块(无样本的也在,前端看板行数稳定)+ 未分类桶 + 全局合计。
 */
export function summarizeSectorSentiment(rows = [], { topSymbols = 5 } = {}) {
  const buckets = new Map(SECTOR_KEYS.map((k) => [k, emptyBucket(k)]));
  const symbolMaps = new Map(SECTOR_KEYS.map((k) => [k, new Map()]));
  buckets.set(UNCLASSIFIED, emptyBucket(UNCLASSIFIED));
  symbolMaps.set(UNCLASSIFIED, new Map());

  const totals = { bullish: 0, bearish: 0, neutral: 0, total: 0 };
  let totalBullWeight = 0;
  let totalBearWeight = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const key = normalizeSector(row.sector) ?? UNCLASSIFIED;
    const bucket = buckets.get(key);
    const symbolMap = symbolMaps.get(key);
    const sentiment =
      row.sentiment === 'bullish' || row.sentiment === 'bearish' ? row.sentiment : 'neutral';
    const weight = sentiment === 'neutral' ? 0 : Math.max(signalStrength(row), 0);

    bucket[sentiment] += 1;
    bucket.total += 1;
    totals[sentiment] += 1;
    totals.total += 1;
    if (sentiment === 'bullish') {
      bucket.bullish_weight += weight;
      totalBullWeight += weight;
    } else if (sentiment === 'bearish') {
      bucket.bearish_weight += weight;
      totalBearWeight += weight;
    }

    const symbol = row.symbol ? String(row.symbol).toUpperCase() : null;
    if (symbol) {
      let entry = symbolMap.get(symbol);
      if (!entry) {
        entry = {
          symbol,
          bullish: 0,
          bearish: 0,
          neutral: 0,
          total: 0,
          bullish_weight: 0,
          bearish_weight: 0,
        };
        symbolMap.set(symbol, entry);
      }
      entry[sentiment] += 1;
      entry.total += 1;
      if (sentiment === 'bullish') entry.bullish_weight += weight;
      else if (sentiment === 'bearish') entry.bearish_weight += weight;
    }
  }

  const sectors = SECTOR_KEYS.map((k) =>
    finalizeBucket(buckets.get(k), symbolMaps.get(k), topSymbols)
  );
  const unclassified = finalizeBucket(
    buckets.get(UNCLASSIFIED),
    symbolMaps.get(UNCLASSIFIED),
    topSymbols
  );

  return {
    sectors,
    unclassified,
    totals: {
      ...totals,
      score: netSentimentScore(totalBullWeight, totalBearWeight),
      classified: totals.total - unclassified.total,
    },
  };
}
