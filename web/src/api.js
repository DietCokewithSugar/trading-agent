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
  trades: (limit = 100, offset = 0) => get(`/trades?limit=${limit}&offset=${offset}`),
  // 新闻流:筛选/搜索在服务端完成,前端不再为过滤拉全量数据
  news: ({ limit = 60, offset = 0, filter = 'all', q = '' } = {}) => {
    const params = new URLSearchParams({ limit, offset });
    if (filter === 'analyzed') params.set('analyzed', 'true');
    if (filter === 'bullish' || filter === 'bearish') params.set('sentiment', filter);
    if (q) params.set('q', q);
    return get(`/news?${params.toString()}`);
  },
  stats: () => get('/stats'),
  performance: () => get('/performance'),
  signalStats: () => get('/signal-stats'),
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
};
