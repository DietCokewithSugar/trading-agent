function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 与 num 的区别:允许 0(例如佣金默认 0,但显式配置 0 也合法)
function num0(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const config = {
  port: process.env.PORT || 3000,

  // FMP (Financial Modeling Prep) — Ultimate 订阅
  fmpApiKey: process.env.FMP_API_KEY || '',

  // DeepSeek — OpenAI 兼容接口
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  // 模型 ID 可配置,例如 deepseek-chat / deepseek-reasoner,或官方文档中最新的模型名
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  // LLM 成本估算单价(美元/百万 token),仅用于管理页运行指标展示。
  // 默认值为 deepseek-chat 牌价的缓存未命中口径(估算上限,命中缓存的输入实际更便宜),
  // 牌价调整或更换模型时通过环境变量覆盖
  deepseekCostPer1MInput: num0(process.env.DEEPSEEK_COST_PER_1M_INPUT, 0.56),
  deepseekCostPer1MOutput: num0(process.env.DEEPSEEK_COST_PER_1M_OUTPUT, 1.68),

  // Supabase(服务端使用 service_role key,绕过 RLS)
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

  // 新闻轮询间隔(秒)。兼容旧的 NEWS_POLL_MINUTES 配置
  newsPollSeconds: num(
    process.env.NEWS_POLL_SECONDS,
    num(process.env.NEWS_POLL_MINUTES, 0) * 60 || 20
  ),
  // 有访客在线时,实时报价/组合估值的推送间隔(秒)
  quotePushSeconds: num(process.env.QUOTE_PUSH_SECONDS, 5),
  // 净值快照间隔(秒)
  snapshotSeconds: num(process.env.SNAPSHOT_SECONDS, 60),
  // 止损/止盈监控间隔(秒)
  riskCheckSeconds: num(process.env.RISK_CHECK_SECONDS, 30),

  // 每轮最多用 DeepSeek 分析多少条新新闻(控制 API 成本)
  maxAnalyzePerCycle: num(process.env.MAX_ANALYZE_PER_CYCLE, 8),

  // 是否补充 Yahoo Finance RSS 新闻源
  enableYahoo: process.env.ENABLE_YAHOO !== 'false',

  // 模拟交易参数
  initialCapital: num(process.env.INITIAL_CAPITAL, 100000),
  // 触发交易决策的最低档位(1=只有一档触发,2=一二档触发,4=全部触发)
  tradeTierThreshold: num(process.env.TRADE_TIER_THRESHOLD, 2),
  // 单只股票市值占组合总值上限
  maxPositionFraction: 0.25,
  // 单笔买入最多动用的现金占总资产比例
  maxBuyCashFraction: 0.2,
  // 低于该金额的订单忽略
  minOrderAmount: 50,
  // 事件去重窗口(小时):同一事件的多渠道报道在该窗口内归并,只触发一次交易
  eventDedupHours: num(process.env.EVENT_DEDUP_HOURS, 72),
  // 综合置信度门槛(0~1):来源可信度 × 分析置信度 × 时效 × 事件档位 低于该值的信号
  // 不立即交易,挂起等待独立信源的交叉确认;设为 0 可关闭该门槛
  minFinalConfidence: Math.min(num0(process.env.MIN_FINAL_CONFIDENCE, 0.35), 1),
  // 同一股票同方向新闻交易的冷却期(分钟),作为事件去重的兜底防线
  tradeCooldownMinutes: num(process.env.TRADE_COOLDOWN_MINUTES, 30),

  // 标的准入门槛(只约束买入,卖出/止损不受限;设为 0 关闭对应项)。
  // FMP 全市场新闻流里大量微盘股是付费拉抬的常客,不设门槛等于向 pump 新闻敞开钱包。
  minMarketCap: num0(process.env.MIN_MARKET_CAP, 300e6),
  minPrice: num0(process.env.MIN_PRICE, 2),
  minAvgDollarVolume: num0(process.env.MIN_AVG_DOLLAR_VOLUME, 5e6),
  // 交易所白名单(FMP profile.exchange 短代码,大小写不敏感;显式设空字符串关闭检查)。
  // 默认只允许三大所,自动屏蔽 OTC/PNK(粉单)——付费拉抬新闻的重灾区。
  // 用 ?? 而非 ||:显式设 ALLOWED_EXCHANGES=(空)才表示关闭
  allowedExchanges: (process.env.ALLOWED_EXCHANGES ?? 'NASDAQ,NYSE,AMEX')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  // 公司公告类来源(新闻稿通道)的利好信号置信度折价(0~1,1=不折价):
  // 公告真实性高但立场天然偏多,折价后多数会落入"挂起等独立媒体交叉确认"流程
  pressBullishPenalty: Math.min(num(process.env.PRESS_BULLISH_PENALTY, 0.75), 1),
  // 开盘队列:休市时段的交易信号挂单等待下一开盘,超过该时长(小时)未成交自动作废
  //(默认 96 小时,覆盖周末与三天长假)
  pendingOrderMaxAgeHours: num(process.env.PENDING_ORDER_MAX_AGE_HOURS, 96),

  // 模拟成交真实化(execution.js):按市值/时段/波动/订单冲击对成交价施加不利滑点
  enableSlippage: process.env.ENABLE_SLIPPAGE !== 'false',
  // 单笔滑点上限(基点,1bp = 0.01%)
  slippageMaxBps: num(process.env.SLIPPAGE_MAX_BPS, 150),
  // 佣金(基点,折算进成交价;美股主流券商零佣金,默认 0)
  commissionBps: num0(process.env.COMMISSION_BPS, 0),
  // 买入漂移熔断:下单时最新价相对 LLM 决策时价格的偏移超过该百分比即放弃
  //(上漂=追 spike 顶部,下漂=行情已反转,决策依据的价格均已失效)
  buyPriceDriftAbortPercent: num(process.env.BUY_PRICE_DRIFT_ABORT_PERCENT, 5),

  // 平仓后是否用 DeepSeek 复盘并沉淀经验教训(注入后续交易决策)
  enableReflection: process.env.ENABLE_REFLECTION !== 'false',

  // 仓位缩放:按信号档位的买入金额乘数(一档全额、二档七折,其余对半;
  // 在 LLM 给出的 fraction 之上叠加,最终仍受硬性风控帽约束)
  tierSizeMultipliers: { 1: 1.0, 2: 0.7 },
  // 移动止损:股价创新高后止损价跟随上抬(只升不降),需执行 007 迁移
  enableTrailingStop: process.env.ENABLE_TRAILING_STOP !== 'false',
  // 每日持仓复查:每个交易日由 DeepSeek 整体评估一次持仓(论点是否失效、是否收紧止损)
  enablePositionReview: process.env.ENABLE_POSITION_REVIEW !== 'false',
  // 持仓复查的触发时间(美东 24 小时制,盘中该小时之后执行,每天一次)
  positionReviewHour: num(process.env.POSITION_REVIEW_HOUR, 14),
  // 风控官:买入执行前由独立 LLM 角色做组合级复核(放行/缩仓/否决),失败时放弃买入
  enableRiskOfficer: process.env.ENABLE_RISK_OFFICER !== 'false',

  // 组合级硬风控(代码强制,先于且独立于 LLM 风控官;只约束买入,卖出/止损永远放行)
  // 当日组合亏损达到该百分比 → 当日停止开新仓(sticky,次日自动恢复;0=关闭)
  dailyLossHaltPercent: num0(process.env.DAILY_LOSS_HALT_PERCENT, 2),
  // 最大同时持仓数(只拦开新仓,加仓不受限;0=关闭)
  maxOpenPositions: num0(process.env.MAX_OPEN_POSITIONS, 10),
  // 单行业市值占组合总值上限(超出部分钳制买入金额;0=关闭)
  maxSectorFraction: Math.min(num0(process.env.MAX_SECTOR_FRACTION, 0.35), 1),
  // 连亏降仓:最近 N 笔卖出全部亏损时,买入比例乘以该系数(1=关闭)
  lossStreakCount: num0(process.env.LOSS_STREAK_COUNT, 3),
  lossStreakScale: Math.min(num0(process.env.LOSS_STREAK_SCALE, 0.5), 1),

  // 关注列表(用于 Yahoo RSS 抓取),持仓股票会自动加入
  watchlist: (process.env.WATCHLIST || 'AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),

  // 可选:设置后,手动触发 /api/run-cycle 需要携带 x-admin-token 请求头
  adminToken: process.env.ADMIN_TOKEN || '',
};

export function assertConfig() {
  const missing = [];
  if (!config.fmpApiKey) missing.push('FMP_API_KEY');
  if (!config.deepseekApiKey) missing.push('DEEPSEEK_API_KEY');
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.supabaseKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    console.warn(`[config] 缺少环境变量: ${missing.join(', ')} — 相关功能将不可用`);
  }
  return missing;
}
