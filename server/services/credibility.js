/**
 * 新闻来源可信度评分。
 *
 * 评分对象是"原始新闻来源"(通讯社/监管文件/公司公告/媒体/博客),而不是抓取渠道:
 * FMP 是新闻发现层(聚合索引),Yahoo RSS 是补充验证层,二者本身不代表内容质量。
 * 因此按文章原文 URL 的域名(其次按 publisher 名称)归入可信度分层;
 * 经 FMP 聚合转发的文章在原始来源分上再扣一个小的聚合折价。
 *
 * 综合置信度 = 来源可信度 × 分析置信度(标的相关性) × 时效分 × 事件档位分,
 * 低于门槛(MIN_FINAL_CONFIDENCE)的信号挂起,等待独立信源交叉确认(eventService)。
 */

/** 来源分层:域名优先精确匹配,publisher 名称作为兜底模糊匹配 */
const SOURCE_TIERS = [
  {
    label: '权威通讯社/监管',
    score: 0.95,
    domains: ['reuters.com', 'apnews.com', 'sec.gov', 'federalreserve.gov'],
    publishers: ['reuters', 'associated press', 'ap news', 'sec'],
  },
  {
    label: '公司公告',
    score: 0.9,
    domains: [
      'prnewswire.com',
      'businesswire.com',
      'globenewswire.com',
      'accesswire.com',
      'newsfilecorp.com',
    ],
    publishers: ['pr newswire', 'prnewswire', 'business wire', 'businesswire', 'globenewswire', 'accesswire'],
  },
  {
    label: '主流财经媒体',
    score: 0.85,
    domains: [
      'bloomberg.com',
      'wsj.com',
      'ft.com',
      'cnbc.com',
      'finance.yahoo.com',
      'barrons.com',
      'economist.com',
      'nytimes.com',
      'forbes.com',
      'fortune.com',
      'businessinsider.com',
    ],
    publishers: [
      'bloomberg',
      'wall street journal',
      'financial times',
      'cnbc',
      'yahoo finance',
      "barron's",
      'forbes',
      'fortune',
    ],
  },
  {
    label: '观点/分析平台',
    score: 0.65,
    domains: [
      'fool.com',
      'seekingalpha.com',
      'marketwatch.com',
      'zacks.com',
      'morningstar.com',
      'investopedia.com',
      'investors.com',
    ],
    publishers: ['motley fool', 'seeking alpha', 'marketwatch', 'zacks', 'morningstar'],
  },
  {
    label: '低可信来源',
    score: 0.5,
    domains: [
      'benzinga.com',
      'moneywise.com',
      'investorplace.com',
      '247wallst.com',
      'thestreet.com',
      'pymnts.com',
      'stocktwits.com',
    ],
    publishers: ['benzinga', 'moneywise', 'investorplace', '24/7 wall st', 'thestreet'],
  },
];

// SEC EDGAR 官方直抓(source='sec-filings')的监管披露档:唯一的 1.00 满分档。
// 放在 SOURCE_TIERS 数组外、只按抓取渠道选中——FMP/Yahoo 转发的 sec.gov 链接
// 仍走域名匹配的 0.95 档(±聚合折价),满分只给官方接口直抓的原始文件
const SEC_FILING_TIER = { label: '监管披露', score: 1.0 };

// 域名不在分层表内:有原文 URL 的小站给中低分,连 URL 都没有的按最低档处理
const UNKNOWN_WITH_URL_SCORE = 0.4;
const UNKNOWN_NO_URL_SCORE = 0.25;
// FMP 聚合转发折价(原始来源分 − 0.03),Yahoo RSS 直达原文不扣
const FMP_AGGREGATION_PENALTY = 0.03;
const MIN_SCORE = 0.2;

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 从文章 URL 提取注册域名(去掉 www. 前缀;finance.yahoo.com 这类有意义的子域保留) */
export function extractDomain(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}

function matchTier(domain, publisher) {
  if (domain) {
    for (const tier of SOURCE_TIERS) {
      if (tier.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return tier;
    }
  }
  const pub = String(publisher || '').toLowerCase();
  if (pub) {
    for (const tier of SOURCE_TIERS) {
      if (tier.publishers.some((p) => pub.includes(p))) return tier;
    }
  }
  return null;
}

/**
 * 对一篇文章的原始来源打分,返回 { domain, score, label }。
 * article: { url, publisher, source }(source 为抓取渠道 fmp-* / yahoo)。
 */
export function scoreSource(article) {
  const domain = extractDomain(article.url);

  // 按抓取渠道强制选档:SEC 官方直抓 → 监管披露满分档;
  // FMP 公告端点(fmp-press)就是公司新闻稿本身,直接按公司公告档计分
  let tier =
    article.source === 'sec-filings'
      ? SEC_FILING_TIER
      : article.source === 'fmp-press'
        ? SOURCE_TIERS[1]
        : matchTier(domain, article.publisher);

  let score;
  let label;
  if (tier) {
    score = tier.score;
    label = tier.label;
  } else if (domain) {
    score = UNKNOWN_WITH_URL_SCORE;
    label = '未知来源';
  } else {
    score = UNKNOWN_NO_URL_SCORE;
    label = '无来源链接';
  }

  // 经 FMP 聚合索引转发的文章,在原始来源分上扣聚合折价
  if (String(article.source || '').startsWith('fmp')) {
    score -= FMP_AGGREGATION_PENALTY;
  }

  return { domain, score: round2(Math.max(score, MIN_SCORE)), label };
}

/**
 * 是否为公司公告类来源(新闻稿通道 / FMP 公告端点)。
 * 公告"真实性"高(评分 0.9)但立场天然偏多,且新闻稿通道是微盘股付费拉抬的经典渠道,
 * 因此利好方向的公告信号在交易门槛上要额外折价(config.pressBullishPenalty)。
 */
export function isPressRelease(article) {
  if (article?.source === 'fmp-press') return true;
  const domain = article?.source_domain || extractDomain(article?.url);
  if (!domain) return false;
  return SOURCE_TIERS[1].domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * 是否为"公司自述类"来源(新闻稿通道 + 公司自报的监管披露如 8-K)。
 * 自述内容真实性高,但立场天然偏发行方:利好方向与新闻稿共享
 * pressBullishPenalty 门槛折价(孤立自述利好挂起等独立信源确认);
 * 利空自述反而是强信号(公司很少自曝坏消息),不折价、按满分可信度直接生效。
 * 注意与 isPressRelease 的分工:统计口径(signalStats 的 is_press 桶、advisor 的
 * press 规则)仍只看新闻稿,监管披露单独用 is_filing 观测,证据链互不污染。
 */
export function isSelfIssued(article) {
  return isPressRelease(article) || article?.source === 'sec-filings';
}

/**
 * 时效分:1 小时内 1.0,随后线性衰减,24 小时以上 0.5;无发布时间按 0.7。
 * nowMs 为"评估时刻"(默认当前时间):回测重析历史新闻时传发布时刻,
 * 把时效钉在 1.0(分析在名义上发生于发布当时),否则历史文章会全部衰减到 0.5
 */
export function recencyScore(publishedAt, nowMs = Date.now()) {
  if (!publishedAt) return 0.7;
  const ageHours = (nowMs - new Date(publishedAt).getTime()) / 3600_000;
  if (!Number.isFinite(ageHours) || ageHours < 0) return 0.7;
  if (ageHours <= 1) return 1;
  return Math.max(0.5, 1 - (0.5 * (ageHours - 1)) / 23);
}

/** 事件档位分(materiality):档位越高事件越重大 */
const TIER_MATERIALITY = { 1: 1, 2: 0.9, 3: 0.75, 4: 0.6 };

/**
 * 综合置信度 = 来源可信度 × 分析置信度 × 时效分 × 事件档位分(0~1,保留三位)。
 * 分析置信度缺失时按 0.7 处理(与仓位缩放链的缺省一致)。
 * nowMs 透传给时效分(回测重析历史新闻时传发布时刻,时效=1.0)。
 */
export function computeFinalConfidence({ sourceScore, confidence, publishedAt, tier, nowMs }) {
  const src = Number.isFinite(Number(sourceScore)) ? Number(sourceScore) : UNKNOWN_WITH_URL_SCORE;
  const conf = Number.isFinite(Number(confidence)) ? Number(confidence) : 0.7;
  const materiality = TIER_MATERIALITY[tier] ?? 0.6;
  const value = src * conf * recencyScore(publishedAt, nowMs ?? Date.now()) * materiality;
  return Math.round(Math.min(Math.max(value, 0), 1) * 1000) / 1000;
}
