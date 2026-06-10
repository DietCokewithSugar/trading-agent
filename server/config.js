function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
  // 同一股票同方向新闻交易的冷却期(分钟),作为事件去重的兜底防线
  tradeCooldownMinutes: num(process.env.TRADE_COOLDOWN_MINUTES, 30),

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
