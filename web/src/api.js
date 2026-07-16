async function get(path) {
  const res = await fetch(`/api${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `请求失败: ${res.status}`);
  }
  return res.json();
}

/** 公开 POST(可选附加请求头,如回测触发的 x-admin-token) */
async function post(path, body, headers = {}) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `请求失败: ${res.status}`);
  }
  return res.json();
}

export const api = {
  portfolio: () => get('/portfolio'),
  snapshots: (hours) => get(`/snapshots${hours ? `?hours=${hours}` : ''}`),
  // before 游标分页:SSE 推送让列表头部增长后 offset 会漂移漏行,加载更多用游标
  trades: (limit = 100, { offset = 0, before = null } = {}) => {
    const params = new URLSearchParams({ limit });
    if (before) params.set('before', before);
    else params.set('offset', offset);
    return get(`/trades?${params.toString()}`);
  },
  // 新闻流:筛选/搜索在服务端完成,前端不再为过滤拉全量数据。
  // date=美东日历日(单日视图),symbol=分析主体精确筛选,tier=档位,band=来源可信度分层
  news: ({
    limit = 60,
    offset = 0,
    before = null,
    filter = 'all',
    q = '',
    symbol = '',
    tier = null,
    band = null,
    date = null,
  } = {}) => {
    const params = new URLSearchParams({ limit });
    if (before) params.set('before', before);
    else params.set('offset', offset);
    if (filter === 'analyzed') params.set('analyzed', 'true');
    if (['bullish', 'bearish', 'neutral'].includes(filter)) params.set('sentiment', filter);
    if (tier) params.set('tier', tier);
    if (band) params.set('band', band);
    if (symbol) params.set('symbol', symbol);
    if (date) params.set('date', date);
    if (q) params.set('q', q);
    return get(`/news?${params.toString()}`);
  },
  stats: () => get('/stats'),
  performance: () => get('/performance'),
  signalStats: (days) => get(`/signal-stats${days ? `?days=${days}` : ''}`),
  shadow: (hours) => get(`/shadow${hours ? `?hours=${hours}` : ''}`),
  shadowTrades: (variant, limit = 100) =>
    get(`/shadow/${encodeURIComponent(variant)}/trades?limit=${limit}`),
  brokerMirror: () => get('/broker-mirror'),
  // date=YYYY-MM-DD(美东日,仅限过去)切历史视图;缺省为实时
  macro: (date) => get(`/macro${date ? `?date=${date}` : ''}`),
  macroHistory: (days = 120) => get(`/macro/history?days=${days}`),
  pool: () => get('/pool'),
  pendingOrders: () => get('/pending-orders'),
  symbol: (symbol) => get(`/symbol/${encodeURIComponent(symbol)}`),
  // 单票轻量报价:个股弹窗对 SSE 未覆盖符号的兜底轮询,不拉分析/交易历史
  quote: (symbol) => get(`/quote/${encodeURIComponent(symbol)}`),
  status: () => get('/status'),
  // 策略回测(032):列表 / 单轮全量 / 发起(服务端配置 ADMIN_TOKEN 时需带令牌)
  backtestRuns: () => get('/backtest'),
  backtestRun: (id) => get(`/backtest/${encodeURIComponent(id)}`),
  startBacktest: (body, token) =>
    post('/backtest/run', body, token ? { 'x-admin-token': token } : {}),
};

/** 管理接口:所有请求携带 x-admin-token 请求头 */
async function adminRequest(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: {
      'x-admin-token': token || '',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `请求失败: ${res.status}`);
  }
  return res.json();
}

export const adminApi = {
  verify: (token) => adminRequest('/verify', { token }),
  status: (token) => adminRequest('/status', { token }),
  metrics: (token) => adminRequest('/metrics', { token }),
  advisor: (token) => adminRequest('/advisor', { token }),
  tradingHalt: (token, halted) =>
    adminRequest('/trading-halt', { method: 'POST', token, body: { halted } }),
  setStrategy: (token, strategy) =>
    adminRequest('/strategy', { method: 'POST', token, body: { strategy } }),
  primaryLedger: (token, enabled) =>
    adminRequest('/primary-ledger', { method: 'POST', token, body: { enabled } }),
  brokerAccounts: (token) => adminRequest('/broker-accounts', { token }),
  brokerPositions: (token) => adminRequest('/broker-accounts/positions', { token }),
  addBrokerAccount: (token, body) =>
    adminRequest('/broker-accounts', { method: 'POST', token, body }),
  updateBrokerAccount: (token, id, body) =>
    adminRequest(`/broker-accounts/${id}`, { method: 'POST', token, body }),
  deleteBrokerAccount: (token, id) =>
    adminRequest(`/broker-accounts/${id}`, { method: 'DELETE', token }),
  liquidateBrokerAccount: (token, id) =>
    adminRequest(`/broker-accounts/${id}/liquidate`, { method: 'POST', token }),
  runCycle: (token) => adminRequest('/run-cycle', { method: 'POST', token }),
  reset: (token) =>
    adminRequest('/reset', { method: 'POST', token, body: { confirm: 'RESET' } }),
};

export function fmtMoney(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

export function fmtPercent(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

export function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const SENTIMENT_LABELS = { bullish: '利好', bearish: '利空', neutral: '中性' };

// 来源可信度分层(与信号质量页同口径:0.85/0.65 分界)
export const CREDIBILITY_BANDS = {
  high: { label: '高可信 (≥85%)' },
  mid: { label: '中等 (65–85%)' },
  low: { label: '低可信 (<65%)' },
};

/** 来源可信度分层归类:high/mid/low,无效输入 null */
export function credibilityBandOf(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  if (s >= 0.85) return 'high';
  if (s >= 0.65) return 'mid';
  return 'low';
}

// 美东日历日(新闻/交易的自然口径):en-CA 区域格式恰为 YYYY-MM-DD
const ET_DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** ISO 时间 → 美东日历日 'YYYY-MM-DD'(无效输入 null) */
export function etDayOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : ET_DAY_FMT.format(d);
}

/** 今天的美东日历日 'YYYY-MM-DD' */
export function etToday() {
  return ET_DAY_FMT.format(new Date());
}

export const TIER_LABELS = {
  1: '第一档 · 程度大 范围大',
  2: '第二档 · 程度大 范围小',
  3: '第三档 · 程度小 范围大',
  4: '第四档 · 程度小 范围小',
};

export const SESSION_LABELS = {
  pre: '盘前',
  regular: '盘中',
  post: '盘后',
  closed: '休市',
};

export const TRIGGER_LABELS = {
  stop_loss: '自动止损',
  take_profit: '自动止盈',
  review: '持仓复查',
  max_hold: '持有超时',
  rotation: '止盈腾位',
};

// ===== 宏观环境与候选池(014)的标签映射 =====

export const REGIME_LABELS = {
  risk_on: '风险偏好',
  neutral: '中性',
  risk_off: '避险',
  macro_shock: '宏观冲击',
};

export const REGIME_TAG_COLORS = {
  risk_on: 'green',
  neutral: 'default',
  risk_off: 'orange',
  macro_shock: 'red',
};

export const CANDIDATE_STATUS_LABELS = {
  pending: '待分配',
  allocated: '已成交',
  capital_constrained: '资金受限',
  macro_filtered: '宏观过滤',
  conflict_hold: '冲突搁置',
  rejected: '已拒绝',
  expired: '已过期',
  cancelled: '已取消',
};

// ===== 主账户交易策略(024)的标签映射 =====

export const STRATEGY_LABELS = {
  default: '默认(候选池 + LLM 决策)',
  wide_bracket: '宽敞口(±4% / 96 小时)',
  trailing_only: '仅移动止损(不设止盈)',
  vol_bracket: '波动自适应敞口',
  immediate_trade: '信号即时成交',
  immediate_rotation: '即时成交 + 止盈腾位',
  equal_weight: '信号等权买入',
};

export const STRATEGY_DESCRIPTIONS = {
  default: '完整决策链:利好信号入候选池,资金分配器按分数排序后经 LLM 决策与风控官审批成交;固定 ±2%/48 小时出场。',
  wide_bracket: '入场链路不变,出场敞口放宽到 ±4%、持有上限 96 小时——检验固定窄敞口是否被噪声扫损。',
  trailing_only: '入场链路不变,新买入只设 −2% 初始止损、不设止盈,创新高后移动止损只升不降——让利润奔跑。',
  vol_bracket: '入场链路不变,出场敞口按该股 20 日已实现波动缩放(1.5%–4% 对称);波动取数失败的单笔回退固定 ±2%。',
  immediate_trade: '信号到达即按确定性仓位(基础 10% × 档位/置信/来源缩放)买入,绕过候选池、LLM 决策与风控官;锁内硬风控(暂停开关/熔断/仓位帽等)仍全部生效,资金分配器暂停。',
  immediate_rotation: '同「信号即时成交」,但现金/容量不足时先全仓止盈最接近止盈价的盈利持仓腾出资金,再重试买入一次。',
  equal_weight: '信号到达即按固定 5% 等权买入,绕过候选池、LLM 决策与风控官;锁内硬风控仍全部生效,资金分配器暂停。',
};

// ===== 影子组合 / 消融实验(017)的标签映射 =====

export const SHADOW_VARIANT_LABELS = {
  actual: '实盘组合',
  no_risk_officer: '无风控官',
  no_risk_officer_rotation: '无风控官+腾位',
  no_macro_filter: '无宏观过滤',
  no_macro_filter_rotation: '无宏观过滤+腾位',
  wide_bracket: '宽敞口离场',
  wide_bracket_rotation: '宽敞口+腾位',
  trailing_only: '仅移动止损',
  trailing_only_rotation: '移动止损+腾位',
  vol_bracket: '波动敞口',
  vol_bracket_rotation: '波动敞口+腾位',
  immediate_trade: '信号即时成交',
  immediate_rotation: '即时腾位',
  equal_weight: '信号等权买入',
  equal_weight_rotation: '等权+腾位',
  spy_benchmark: 'SPY 买入持有',
  cash: '纯现金',
};

// 腾位孪生(025)的统一说明:与基础变体逐项相同,唯一差异是现金/容量不足时
// 先全仓止盈腾位选仓(trailing 系按浮盈比例最高,其余按最接近止盈价)再重试买入
const ROTATION_TWIN_NOTE = '与基础变体完全相同,仅在现金不足时先卖出腾位选仓再重试买入——与基础变体对比隔离止盈腾位机制的净贡献';

export const SHADOW_VARIANT_DESCRIPTIONS = {
  actual: '当前真实模拟组合(全部防线开启)',
  no_risk_officer: '跟随实盘,但风控官否决/缩仓的买入按否决前方案照样执行',
  no_macro_filter: '跟随实盘,但被宏观层(环境过滤/冲击/黑窗/预算钳制)拦截的买入照样执行',
  wide_bracket: '1:1 跟随实盘买入,但止损/止盈放宽到 ±4%、持有上限 96 小时——检验固定 ±2%/48h 是否过窄(噪音扫损)',
  trailing_only: '1:1 跟随实盘买入,初始止损同实盘距离但不设止盈上限,移动止损只升不降——检验固定止盈是否截断利润',
  vol_bracket: '1:1 跟随实盘买入,止损/止盈按该股 20 日波动自适应(1.5%–4%)——实盘开关开启前的对照实验,跑赢则顾问提示在管理页开启',
  immediate_trade: '独立组合:可交易利好信号到达即按确定性仓位买入(休市信号顺延至下一可交易时段),不经候选池与 LLM 决策',
  immediate_rotation: '独立组合:同「信号即时成交」,但现金不足时先全仓止盈最接近止盈价的盈利持仓腾出资金再买——与即时成交对比度量止盈腾位的净贡献',
  equal_weight: '独立组合:可交易信号一律按固定比例等权买入(休市信号顺延),检验 LLM 仓位是否有效',
  spy_benchmark: '启用时一次性全仓买入 SPY 并持有',
  cash: '不做任何交易的现金基准',
  no_risk_officer_rotation: `「无风控官」的腾位孪生:${ROTATION_TWIN_NOTE}`,
  no_macro_filter_rotation: `「无宏观过滤」的腾位孪生:${ROTATION_TWIN_NOTE}`,
  wide_bracket_rotation: `「宽敞口离场」的腾位孪生:${ROTATION_TWIN_NOTE}`,
  trailing_only_rotation: `「仅移动止损」的腾位孪生(无止盈价,腾位按浮盈比例最高选仓):${ROTATION_TWIN_NOTE}`,
  vol_bracket_rotation: `「波动敞口」的腾位孪生:${ROTATION_TWIN_NOTE}`,
  equal_weight_rotation: `「信号等权买入」的腾位孪生:${ROTATION_TWIN_NOTE}`,
};

export const MACRO_EVENT_TYPE_LABELS = {
  CPI: 'CPI 通胀',
  PPI: 'PPI 通胀',
  FOMC: '美联储/利率',
  NFP: '非农就业',
  GDP: 'GDP',
  yields: '国债收益率',
  tariffs: '关税/贸易',
  geopolitics: '地缘政治',
  energy: '能源',
  fiscal: '财政',
  other: '其他',
};

// ===== 管理页运行指标的标签映射 =====

export const RUN_TRIGGER_LABELS = {
  scheduler: '调度',
  manual: '手动',
  admin: '管理',
};

export const LLM_PURPOSE_LABELS = {
  analyst: '新闻分析',
  trader: '交易决策',
  'risk-officer': '风控审批',
  'event-matcher': '事件归并',
  review: '持仓复查',
  reflection: '平仓复盘',
  'macro-analyst': '宏观分析',
  'macro-event-matcher': '宏观事件归并',
  'backtest-analyst': '回测新闻分析',
  other: '其他',
};

/** 策略回测(032):策略键与展示名(ai 高亮主线,buy_hold 虚线基准) */
export const BACKTEST_STRATEGY_LABELS = {
  ai: 'AI 新闻策略',
  buy_hold: '买入持有',
  macd: 'MACD',
  kdj_rsi: 'KDJ+RSI',
  zmr: '零均值回归',
  sma: 'SMA 双均线',
};

export const BACKTEST_STATUS_LABELS = {
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** 回测信号丢弃原因(与 aiSignals.js dropped 键对齐) */
export const BACKTEST_DROP_LABELS = {
  irrelevant: '与个股无关',
  symbol_mismatch: '主体非查询标的',
  neutral: '中性',
  low_tier: '档位不足',
  low_confidence: '置信度不足',
  below_final_confidence: '综合置信度低于门槛',
  no_execution_date: '无有效发布时间',
  merged: '同日同向归并',
  conflict: '同日多空冲突',
};

export const REJECT_LABELS = {
  event_dedup: '重复事件去重',
  held_low_confidence: '低置信挂起观察',
  confirm_below_threshold: '交叉确认后仍低于门槛',
  no_quote: '无法获取报价',
  not_actively_trading: '标的未在正常交易',
  eligibility_gate: '未过标的准入门槛',
  symbol_invalid: '标的核验未通过',
  llm_hold: '决策为观望',
  risk_officer_veto: '风控官否决',
  risk_officer_error: '风控官审批失败',
  price_drift_abort: '价格漂移熔断',
  below_min_amount: '金额低于下限',
  trading_halted: '交易暂停(人工开关)',
  symbol_halted: '停牌暂缓交易',
  daily_loss_halt: '当日亏损熔断',
  max_positions: '持仓数达上限',
  sector_cap: '行业集中度上限',
  macro_shock: '宏观冲击暂停',
  new_position_quota: '当日开仓数上限',
  cash_reserve: '现金保留下限',
  daily_budget: '当日预算耗尽',
  gross_exposure: '总敞口上限',
  cooldown: '冷却期',
  position_cap: '单票仓位上限',
  candidate_state_changed: '候选状态已变更',
  valuation_unreliable: '持仓报价缺失',
  buy_on_non_bullish: '非利好信号买入拦截',
  candidate_orphan: '候选关联数据缺失',
};
