async function get(path) {
  const res = await fetch(`/api${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `请求失败: ${res.status}`);
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
  // 新闻流:筛选/搜索在服务端完成,前端不再为过滤拉全量数据
  news: ({ limit = 60, offset = 0, before = null, filter = 'all', q = '' } = {}) => {
    const params = new URLSearchParams({ limit });
    if (before) params.set('before', before);
    else params.set('offset', offset);
    if (filter === 'analyzed') params.set('analyzed', 'true');
    if (filter === 'bullish' || filter === 'bearish') params.set('sentiment', filter);
    if (q) params.set('q', q);
    return get(`/news?${params.toString()}`);
  },
  stats: () => get('/stats'),
  performance: () => get('/performance'),
  signalStats: (days) => get(`/signal-stats${days ? `?days=${days}` : ''}`),
  shadow: (hours) => get(`/shadow${hours ? `?hours=${hours}` : ''}`),
  shadowTrades: (variant, limit = 100) =>
    get(`/shadow/${encodeURIComponent(variant)}/trades?limit=${limit}`),
  macro: () => get('/macro'),
  pool: () => get('/pool'),
  pendingOrders: () => get('/pending-orders'),
  symbol: (symbol) => get(`/symbol/${encodeURIComponent(symbol)}`),
  status: () => get('/status'),
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

// ===== 影子组合 / 消融实验(017)的标签映射 =====

export const SHADOW_VARIANT_LABELS = {
  actual: '实盘组合',
  no_risk_officer: '无风控官',
  no_macro_filter: '无宏观过滤',
  immediate_trade: '信号即时成交',
  equal_weight: '信号等权买入',
  spy_benchmark: 'SPY 买入持有',
  cash: '纯现金',
};

export const SHADOW_VARIANT_DESCRIPTIONS = {
  actual: '当前真实模拟组合(全部防线开启)',
  no_risk_officer: '跟随实盘,但风控官否决/缩仓的买入按否决前方案照样执行',
  no_macro_filter: '跟随实盘,但被宏观层(环境过滤/冲击/黑窗/预算钳制)拦截的买入照样执行',
  immediate_trade: '独立组合:可交易利好信号到达即按确定性仓位买入(休市信号顺延至下一可交易时段),不经候选池与 LLM 决策',
  equal_weight: '独立组合:可交易信号一律按固定比例等权买入(休市信号顺延),检验 LLM 仓位是否有效',
  spy_benchmark: '启用时一次性全仓买入 SPY 并持有',
  cash: '不做任何交易的现金基准',
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
  other: '其他',
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
