function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 与 num 的区别:允许 0(例如佣金默认 0,但显式配置 0 也合法)
function num0(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// 反向代理跳数解析:false/0=不信任(直连部署),正整数=信任前 N 跳(Render 单层代理为 1)
function parseTrustProxy(value) {
  if (value === undefined || value === '') return 1;
  if (/^(false|0)$/i.test(String(value).trim())) return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

// 固定止盈/止损百分比(相对加权平均成本;代码强制,覆盖 LLM 的止损建议)。
// 提为模块级常量:shadowDefaultStops 需要在对象字面量内引用同一组值
const stopLossPercent = num(process.env.STOP_LOSS_PERCENT, 2);
const takeProfitPercent = num(process.env.TAKE_PROFIT_PERCENT, 2);

export const config = {
  port: process.env.PORT || 3000,
  // 信任的反向代理跳数:决定 req.ip 的取值,鉴权失败限流按 IP 计数。
  // 无代理直连部署必须设 TRUST_PROXY=0,否则客户端可伪造 X-Forwarded-For 绕过限流
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

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

  // ── 券商模拟对照账本(021,Alpaca Paper Trading)──
  // 实盘每笔成交镜像到券商模拟账户(marketable 限价单),度量成交价/净值偏差,
  // 校准内部滑点模型。纯观测层:key 缺失时整体停用,绝不影响交易主链路
  alpacaKeyId: process.env.ALPACA_KEY_ID || '',
  alpacaSecretKey: process.env.ALPACA_SECRET_KEY || '',
  alpacaBaseUrl: process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets',
  enableBrokerMirror: process.env.ENABLE_BROKER_MIRROR !== 'false',
  // marketable 限价单的穿价容忍(%):买 = 内部成交价 ×(1+N%),卖 = ×(1−N%);
  // 当日有效,收盘未成交自动过期并计入"未成交"偏差样本
  brokerMirrorLimitSlackPercent: num(process.env.BROKER_MIRROR_LIMIT_SLACK_PERCENT, 1),

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
  // 近似重复判定的相似度阈值(0~1):标题/事件归纳的 Jaccard 相似度 ≥ 该值即判为同一事件,
  // 作为 LLM 事件归并的确定性兜底(同源新闻稿易绕过 LLM 去重)。取高更稳,过度合并只会少交易
  eventNearDupSimilarity: Math.min(num0(process.env.EVENT_NEAR_DUP_SIMILARITY, 0.8), 1),
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
  // 公告真实性高但立场天然偏多,折价后多数会落入"挂起等独立媒体交叉确认"流程。
  // num0:显式配置 0(完全不信任公告类利好)也合法,不静默回退默认值
  pressBullishPenalty: Math.min(num0(process.env.PRESS_BULLISH_PENALTY, 0.75), 1),
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
  // 开盘窗口滑点放大:开盘竞价后的前 N 分钟点差/波动显著放宽(开盘触发的分配轮
  // 与开盘队列成交都落在这个窗口),regular 时段内对滑点额外乘以该系数
  openingWindowMinutes: num0(process.env.OPENING_WINDOW_MINUTES, 15),
  openingSlippageMult: num(process.env.OPENING_SLIPPAGE_MULT, 2),

  // 平仓后是否用 DeepSeek 复盘并沉淀经验教训(注入后续交易决策)
  enableReflection: process.env.ENABLE_REFLECTION !== 'false',

  // 仓位缩放:按信号档位的买入金额乘数(一档全额、二档七折,其余对半;
  // 在 LLM 给出的 fraction 之上叠加,最终仍受硬性风控帽约束)
  tierSizeMultipliers: { 1: 1.0, 2: 0.7 },
  // 固定止盈/止损(代码强制):买入均价 ±N%,触及即全仓卖出;LLM 的止损建议被覆盖
  stopLossPercent,
  takeProfitPercent,
  // 同票新利好(一/二档、经事件去重)刷新持有时钟时,止盈线每次上抬的百分点(0=只刷新时钟)
  takeProfitStepPercent: num0(process.env.TAKE_PROFIT_STEP_PERCENT, 1),
  // 持仓最长持有小时数:超时由风控循环全仓卖出(trigger='max_hold');
  // 同票新利好刷新时钟,买入成交也刷新;0=关闭;需执行 020 迁移
  maxHoldHours: num0(process.env.MAX_HOLD_HOURS, 48),
  // 移动止损:股价创新高后止损价跟随上抬(只升不降),需执行 007 迁移。
  // 固定 ±2% 止盈止损语义下默认关闭("买入价变动 ±N% 即卖出"),显式设 true 才启用
  enableTrailingStop: process.env.ENABLE_TRAILING_STOP === 'true',
  // 波动自适应敞口(023):bracket = clamp(k × 20日已实现日波动, min%, max%),对称止损止盈。
  // 三个参数是 env 常量;开/关是运行时开关(管理员页切换,持久化在 portfolio_state,
  // 无 ENABLE_VOL_BRACKET 环境变量)。关闭期间 vol_bracket 影子变体持续积累对照证据
  bracketVolK: num(process.env.BRACKET_VOL_K, 1),
  bracketMinPercent: num(process.env.BRACKET_MIN_PERCENT, 1.5),
  bracketMaxPercent: num(process.env.BRACKET_MAX_PERCENT, 4),
  // 出场消融影子变体(代码常量):wide_bracket 的固定宽度与每变体持有时限覆盖
  shadowWideBracketPercent: 4,
  shadowVariantMaxHoldHours: { wide_bracket: 96 },
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
  maxOpenPositions: num0(process.env.MAX_OPEN_POSITIONS, 15),
  // 单行业市值占组合总值上限(超出部分钳制买入金额;0=关闭)
  maxSectorFraction: Math.min(num0(process.env.MAX_SECTOR_FRACTION, 0.35), 1),
  // 连亏降仓:最近 N 笔卖出全部亏损时,买入比例乘以该系数(1=关闭)
  lossStreakCount: num0(process.env.LOSS_STREAK_COUNT, 3),
  lossStreakScale: Math.min(num0(process.env.LOSS_STREAK_SCALE, 0.5), 1),

  // ── 宏观信号层(014)──
  // 总开关:关闭后整体退回"纯新闻即时模式"(无宏观分析/候选池/分配器,行为同 013)
  enableMacro: process.env.ENABLE_MACRO !== 'false',
  // 经济日历刷新间隔(分钟);FMP 套餐不含该端点时自动停用(黑窗失效,其余宏观功能不受影响)
  calendarPollMinutes: num(process.env.CALENDAR_POLL_MINUTES, 60),
  // 宏观事件有效窗口(小时):聚合 regime 时只看该窗口内的事件
  macroEventValidityHours: num(process.env.MACRO_EVENT_VALIDITY_HOURS, 72),
  // 宏观冲击持续时长(小时):一档高置信 risk_off 事件触发 macro_shock 后的锁定期
  macroShockHours: num(process.env.MACRO_SHOCK_HOURS, 6),
  // macro_shock 触发所需的最少佐证:归并报道篇数 ≥ N 或独立信源域名 ≥ N
  //(1=恢复单篇即触发的旧行为;016 之前的存量行缺佐证字段时回退旧行为,安全线不静默失效)
  macroShockMinReports: num(process.env.MACRO_SHOCK_MIN_REPORTS, 2),
  // 确定性市场环境核验:SPY 趋势(20 日均线)+ VIX 推出与新闻无关的 regime,
  // 仅当其同向时才放行 risk_on 的仓位放大(否则按 neutral 参数执行);
  // VIX 报价不可用自动退化为仅 SPY 趋势,SPY 历史不可用则整体停用(fail-open 不影响交易)
  enableMarketCheck: process.env.ENABLE_MARKET_CHECK !== 'false',
  marketCheckPollMinutes: num(process.env.MARKET_CHECK_POLL_MINUTES, 10),
  // 核验阈值(代码常量,沿 macroRegimeParams 先例):SMA 缓冲带 ±0.5%,VIX<20 才算 risk_on、≥26 即 risk_off
  marketCheckParams: { smaDays: 20, smaBufferPercent: 0.5, vixRiskOnMax: 20, vixRiskOffMin: 26 },
  // 重大数据发布黑窗:发布前/后 N 分钟内不执行新的买入分配(卖出/止损不受影响;0=关闭)
  blackoutBeforeMinutes: num0(process.env.BLACKOUT_BEFORE_MINUTES, 30),
  blackoutAfterMinutes: num0(process.env.BLACKOUT_AFTER_MINUTES, 30),

  // ── 候选池与资金分配器(014)──
  // 盘中分配节奏:每 N 分钟一轮(开盘后首轮立即执行,清算隔夜积累的候选)
  allocationIntervalMinutes: num(process.env.ALLOCATION_INTERVAL_MINUTES, 15),
  // 每轮分配最多执行的买入候选数(LLM 交易决策只对这些头部候选发生)
  maxAllocationsPerRun: num(process.env.MAX_ALLOCATIONS_PER_RUN, 3),
  // 候选有效期(小时):新闻信号的时效性,超龄自动过期
  candidateMaxAgeHours: num(process.env.CANDIDATE_MAX_AGE_HOURS, 24),
  // 当日最多开多少个新仓(加仓不计;0=关闭)。
  // 高频轮换模式(持仓上限 15 + 48h 时限)下默认关闭,新仓节奏由宏观预算钳制与现金约束控制
  maxNewPositionsPerDay: num0(process.env.MAX_NEW_POSITIONS_PER_DAY, 0),
  // 同票多空冲突判定窗口(分钟):窗口内存在反向高置信信号时进入冲突消解
  conflictWindowMinutes: num(process.env.CONFLICT_WINDOW_MINUTES, 120),
  // 各宏观环境下的组合参数(代码常量,沿 tierSizeMultipliers 先例不逐项开 env):
  // minCashReserve=现金保留下限(占组合总值) dailyBuyBudget=当日买入预算(占当日初组合总值)
  // maxGrossExposure=持仓总敞口上限 macroMultiplier=买入金额宏观乘数 allowedTiers=允许的信号档位
  macroRegimeParams: {
    risk_on: { minCashReserve: 0.15, dailyBuyBudget: 0.45, maxGrossExposure: 0.85, macroMultiplier: 1.2, allowedTiers: [1, 2] },
    neutral: { minCashReserve: 0.25, dailyBuyBudget: 0.35, maxGrossExposure: 0.75, macroMultiplier: 1.0, allowedTiers: [1, 2] },
    risk_off: { minCashReserve: 0.4, dailyBuyBudget: 0.15, maxGrossExposure: 0.5, macroMultiplier: 0.5, allowedTiers: [1], minConfidence: 0.7 },
    macro_shock: { minCashReserve: 1, dailyBuyBudget: 0, maxGrossExposure: 0, macroMultiplier: 0, allowedTiers: [] },
  },

  // LLM 交易决策可回放(018):每次交易员决策连同风控官审批落库完整 prompt/原始返回,
  // 改 prompt/换模型后可用旧输入离线重放对比;表缺失自动停用
  enableDecisionLog: process.env.ENABLE_DECISION_LOG !== 'false',

  // ── 影子组合 / 消融实验(017)──
  // 与实盘并行记账的多套虚拟组合,每套关闭一层防线(风控官/宏观过滤/候选池/LLM 仓位),
  // 外加 SPY 买入持有与纯现金基准;纯观测层,表缺失(未执行 017 迁移)时自动停用
  enableShadow: process.env.ENABLE_SHADOW !== 'false',
  // 影子组合中无 LLM 决策路径的确定性基础仓位(占组合总值比例,
  // 再叠加 sizing.js 的档位/置信度/来源缩放;immediate_trade 与宏观拦截重放用)
  shadowBaseFraction: Math.min(num(process.env.SHADOW_BASE_FRACTION, 0.1), 1),
  // equal_weight 变体的固定等权买入比例(占组合总值)
  shadowEqualWeightFraction: Math.min(num(process.env.SHADOW_EQUAL_WEIGHT_FRACTION, 0.05), 1),
  // 影子组合确定性买入的默认止损/止盈百分比:与实盘一致取固定 ±N% 配置,
  // 保证消融对比中各变体的离场规则相同
  shadowDefaultStops: { stopLossPercent, takeProfitPercent },
  // 影子净值快照最小间隔(分钟,搭车主快照循环并自行限频)
  shadowSnapshotMinutes: 10,

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
