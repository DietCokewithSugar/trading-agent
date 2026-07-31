/**
 * 估值看板(033)纯函数层:信号分类 / 定投档位判定 / 市场结论文案 / 序列统计。
 * 零 IO、可单测;取数与编排在 valuationBoard.js。
 *
 * 信号语义:无论数值方向(VIX 飙升为「高」、RSI 超卖为「低」),同属「买入机会」
 * 逻辑即同色提醒 —— triggered(触发,绿)/ near(接近,黄)/ idle(未触发)/ na(暂无数据)。
 * near 档统一为触发阈值的 nearRatio(默认 75%)逼近带。
 */

export const SIGNAL_STATES = ['triggered', 'near', 'idle', 'na'];

// 五档定投倍数(与看板文案一一对应;active 由 decideDcaTier 判定)
export const DCA_TIERS = [
  { multiplier: 0.25, label: '极高·微量攒子弹' },
  { multiplier: 0.5, label: '估值偏高·减量' },
  { multiplier: 1, label: '常态基准' },
  { multiplier: 1.5, label: '接近信号·增配' },
  { multiplier: 2, label: '恐慌深跌·加倍' },
];

// 注意区分「缺失」与 0:Number(null)/Number('') 均为 0,必须先排除
const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const round = (v, digits = 2) =>
  isNum(v) ? Math.round(Number(v) * 10 ** digits) / 10 ** digits : null;

/**
 * 单指标三态分类。
 *  direction 'above':数值越过阈值向上触发(VIX > trigger);
 *  direction 'below':数值跌破阈值向下触发(RSI/情绪/PE 分位 < trigger,回撤/急跌 ≤ trigger)。
 * near 逼近带:above → value ≥ trigger×nearRatio;
 *             below 且 trigger>0 → value ≤ trigger÷nearRatio(如 RSI 22 → 29.3);
 *             below 且 trigger<0 → value ≤ trigger×nearRatio(如回撤 -20% → -15%)。
 * 数值缺失返回 'na'。
 */
export function classifySignal({ value, trigger, direction, nearRatio = 0.75 }) {
  if (!isNum(value) || !isNum(trigger)) return 'na';
  const v = Number(value);
  const t = Number(trigger);
  if (direction === 'above') {
    if (v > t) return 'triggered';
    if (v >= t * nearRatio) return 'near';
    return 'idle';
  }
  // below:负阈值(回撤/急跌)含等号触发,与「≤ -20%」的口径一致
  if (t < 0 ? v <= t : v < t) return 'triggered';
  const nearBound = t < 0 ? t * nearRatio : t / nearRatio;
  if (v <= nearBound) return 'near';
  return 'idle';
}

const STATE_RANK = { triggered: 0, near: 1, idle: 2, na: 3 };

/**
 * 双指数指标取「更极端」一侧作为卡片主值:先比状态(triggered > near > idle),
 * 同状态比谁离触发更近(below 方向取更小值,above 取更大值);全 na 返回 null。
 * entries: [{ key, label, value, state }]
 */
export function pickExtreme(entries, direction) {
  const usable = (entries || []).filter((e) => e && e.state !== 'na');
  if (!usable.length) return null;
  return usable.reduce((best, e) => {
    const cmp = STATE_RANK[e.state] - STATE_RANK[best.state];
    if (cmp < 0) return e;
    if (cmp > 0) return best;
    if (direction === 'above') return Number(e.value) > Number(best.value) ? e : best;
    return Number(e.value) < Number(best.value) ? e : best;
  });
}

// ── 语义分类标签(卡片副标题用)──

export function classifyVixLevel(v) {
  if (!isNum(v)) return null;
  if (v > 30) return '恐慌';
  if (v >= 20) return '偏高';
  return '正常';
}

export function classifyFearGreedLevel(v) {
  if (!isNum(v)) return null;
  if (v < 25) return '极度恐惧';
  if (v < 45) return '恐惧';
  if (v < 55) return '中性';
  if (v < 75) return '贪婪';
  return '极度贪婪';
}

export function classifyRsiLevel(v) {
  if (!isNum(v)) return null;
  if (v < 22) return '超卖';
  if (v < 40) return '偏弱';
  if (v <= 60) return '中性';
  if (v <= 78) return '偏强';
  return '超买';
}

export function classifyPeLevel(pct) {
  if (!isNum(pct)) return null;
  if (pct < 20) return '显著低估';
  if (pct < 30) return '偏低';
  if (pct < 70) return '正常';
  if (pct < 85) return '偏高';
  return '极高';
}

export function classifyDrawdownLevel(v) {
  if (!isNum(v)) return null;
  if (v <= -20) return '深度';
  if (v <= -10) return '中度';
  return '浅';
}

export function classifyCrashLevel(v) {
  if (!isNum(v)) return null;
  if (v <= -12) return '急跌';
  if (v <= -6) return '偏弱';
  return '平稳';
}

const INDEX_LABELS = { ndx: '纳指', spx: '标普' };

/** 双指数子项:逐指数分类,供 buildSignals 与卡片「纳指 x · 标普 y」行使用 */
function perIndexEntries(values, { trigger, direction, nearRatio }) {
  return ['ndx', 'spx'].map((key) => {
    const value = round(values?.[key], 2);
    return {
      key,
      label: INDEX_LABELS[key],
      value,
      state: classifySignal({ value, trigger, direction, nearRatio }),
    };
  });
}

/**
 * 组装六张信号卡。inputs:
 *  { vix, fearGreed, rsi:{ndx,spx}, pePct:{ndx,spx}, drawdown:{ndx,spx}, crash:{ndx,spx} }
 * cfg 取 config.valuationBoard 形状。返回按看板顺序的信号数组。
 */
export function buildSignals(inputs = {}, cfg = {}) {
  const nearRatio = cfg.nearRatio ?? 0.75;
  const signals = [];

  const vix = round(inputs.vix, 2);
  signals.push({
    key: 'vix',
    label: 'VIX',
    state: classifySignal({ value: vix, trigger: cfg.vixTrigger, direction: 'above', nearRatio }),
    value: vix,
    unit: '',
    level: classifyVixLevel(vix),
    trigger_text: `> ${cfg.vixTrigger}`,
    per_index: null,
    meta: '恐慌指数现值',
  });

  const fg = round(inputs.fearGreed, 0);
  signals.push({
    key: 'fear_greed',
    label: '恐惧贪婪',
    state: classifySignal({
      value: fg,
      trigger: cfg.fearGreedTrigger,
      direction: 'below',
      nearRatio,
    }),
    value: fg,
    unit: '',
    level: classifyFearGreedLevel(fg),
    trigger_text: `< ${cfg.fearGreedTrigger}`,
    per_index: null,
    meta: '市场情绪指数(0 极度恐惧 – 100 极度贪婪)',
  });

  const rsiOpts = { trigger: cfg.rsiTrigger, direction: 'below', nearRatio };
  const rsiEntries = perIndexEntries(inputs.rsi, rsiOpts);
  const rsiBest = pickExtreme(rsiEntries, 'below');
  signals.push({
    key: 'rsi',
    label: `RSI(${cfg.rsiPeriod ?? 6})`,
    state: rsiBest ? rsiBest.state : 'na',
    value: rsiBest ? rsiBest.value : null,
    unit: '',
    level: classifyRsiLevel(rsiBest?.value),
    trigger_text: `< ${cfg.rsiTrigger}`,
    per_index: rsiEntries,
    meta: `${cfg.rsiPeriod ?? 6} 日相对强弱,低于 ${cfg.rsiTrigger} 为超卖`,
  });

  const peOpts = { trigger: cfg.pePctTrigger, direction: 'below', nearRatio };
  const peEntries = perIndexEntries(inputs.pePct, peOpts);
  const peBest = pickExtreme(peEntries, 'below');
  signals.push({
    key: 'pe_percentile',
    label: 'PE 百分位',
    state: peBest ? peBest.state : 'na',
    value: peBest ? peBest.value : null,
    unit: '%',
    level: classifyPeLevel(peBest?.value),
    trigger_text: `< ${cfg.pePctTrigger}%`,
    per_index: peEntries,
    meta: 'TTM PE 历史分位(标普500 / 纳指100 口径)',
  });

  const ddOpts = { trigger: cfg.drawdownTrigger, direction: 'below', nearRatio };
  const ddEntries = perIndexEntries(inputs.drawdown, ddOpts);
  const ddBest = pickExtreme(ddEntries, 'below');
  signals.push({
    key: 'drawdown_52w',
    label: '52周回撤',
    state: ddBest ? ddBest.state : 'na',
    value: ddBest ? ddBest.value : null,
    unit: '%',
    level: classifyDrawdownLevel(ddBest?.value),
    trigger_text: `≤ ${cfg.drawdownTrigger}%`,
    per_index: ddEntries,
    meta: '现价相对 52 周高点的回撤',
  });

  const crOpts = { trigger: cfg.crashTrigger, direction: 'below', nearRatio };
  const crEntries = perIndexEntries(inputs.crash, crOpts);
  const crBest = pickExtreme(crEntries, 'below');
  signals.push({
    key: 'crash_25d',
    label: `${cfg.crashWindowDays ?? 25}日急跌`,
    state: crBest ? crBest.state : 'na',
    value: crBest ? crBest.value : null,
    unit: '%',
    level: classifyCrashLevel(crBest?.value),
    trigger_text: `≤ ${cfg.crashTrigger}%`,
    per_index: crEntries,
    meta: `现价相对近 ${cfg.crashWindowDays ?? 25} 个交易日高点的跌幅`,
  });

  return signals;
}

const SIGNAL_SHORT_LABELS = {
  vix: 'VIX',
  fear_greed: '恐惧贪婪',
  rsi: 'RSI',
  pe_percentile: 'PE 分位',
  drawdown_52w: '52周回撤',
  crash_25d: '短期急跌',
};

/**
 * 五档定投倍数判定(纯代码规则,无 LLM)。优先级:
 *  任一信号触发(绿)→ 2×(恐慌深跌·加倍);
 *  任一信号接近(黄)或情绪 < fearGreedCaution → 1.5×(接近信号·增配);
 *  PE 分位 ≥ peExtremePct → 0.25×;≥ peHighPct → 0.5×(估值降档,PE 缺失时静默跳过);
 *  其余 → 1×(常态基准)。
 * pePct 取纳指/标普中的较高者(保守:任一偏贵即减量)。
 * 返回 { multiplier, reason }。
 */
export function decideDcaTier({ signals = [], fearGreed = null, pePct = null } = {}, cfg = {}) {
  const caution = cfg.fearGreedCaution ?? 45;
  const highPct = cfg.peHighPct ?? 70;
  const extremePct = cfg.peExtremePct ?? 85;

  const names = (state) =>
    signals.filter((s) => s.state === state).map((s) => SIGNAL_SHORT_LABELS[s.key] || s.label);

  const triggered = names('triggered');
  if (triggered.length) {
    return {
      multiplier: 2,
      reason: `极端买入信号命中(${triggered.join('、')})→ 恐慌深跌,定投加倍 2×`,
    };
  }

  const near = names('near');
  const fearful = isNum(fearGreed) && Number(fearGreed) < caution;
  if (near.length || fearful) {
    const parts = [];
    if (near.length) parts.push(`接近买入信号(${near.join('、')})`);
    if (fearful) parts.push(`情绪偏谨慎(恐惧贪婪 ${Math.round(Number(fearGreed))} < ${caution})`);
    return { multiplier: 1.5, reason: `${parts.join(' / ')} → 增配定投 1.5×` };
  }

  if (isNum(pePct)) {
    const pct = Math.round(Number(pePct));
    if (pct >= extremePct) {
      return {
        multiplier: 0.25,
        reason: `估值极高(PE 历史分位 ${pct}% ≥ ${extremePct}%)→ 微量定投攒子弹 0.25×`,
      };
    }
    if (pct >= highPct) {
      return {
        multiplier: 0.5,
        reason: `估值偏高(PE 历史分位 ${pct}% ≥ ${highPct}%)→ 减量定投 0.5×`,
      };
    }
    return { multiplier: 1, reason: '无极端信号,估值与情绪常态 → 常态基准定投 1×' };
  }
  return {
    multiplier: 1,
    reason: '无极端信号 → 常态基准定投 1×(估值分位暂无数据,未参与判定)',
  };
}

const ADVICE_BY_MULTIPLIER = {
  2: '极端信号命中,恐慌深跌加倍定投;严格分批执行,不加杠杆、不一次性梭哈。',
  1.5: '维持正常持仓,定投金额提升至 1.5 倍,把握低位布局机会;仍不建议大额一次性追高,分批布局更稳妥。',
  1: '按常规节奏定投,维持既有仓位;不追高、不预测,纪律优先。',
  0.5: '估值偏高,定投减量执行;保留子弹等待更好位置,避免情绪化追高。',
  0.25: '估值极高,仅微量定投保持参与;耐心等待极端买入信号,不追涨。',
};

/**
 * 今日市场结论四行文案。输入均可缺失(对应行降级为「暂无数据」):
 *  pe:{ ndx, spx } 为 PE 历史分位(0–100);trendGap:{ ndx, spx } 为现价相对 200 日均线的 ±%。
 */
export function buildConclusion(
  { pe = {}, fearGreed = null, vix = null, trendGap = {}, multiplier = 1 } = {}
) {
  const pcts = [pe.ndx, pe.spx].filter(isNum).map(Number);
  let valuation = '暂无数据(外部估值源暂不可用)';
  if (pcts.length) {
    const level = classifyPeLevel(Math.max(...pcts));
    const parts = [];
    if (isNum(pe.spx)) parts.push(`标普 ${Math.round(pe.spx)}%`);
    if (isNum(pe.ndx)) parts.push(`纳指100 ${Math.round(pe.ndx)}%`);
    valuation = `${level}(TTM PE 历史分位 ${parts.join('、')})`;
  }

  let sentiment = '暂无数据(外部情绪源暂不可用)';
  if (isNum(fearGreed)) {
    sentiment = `${classifyFearGreedLevel(fearGreed)}(恐惧贪婪 ${Math.round(Number(fearGreed))}${isNum(vix) ? `,VIX ${round(vix, 2)}` : ''})`;
  } else if (isNum(vix)) {
    sentiment = `VIX ${round(vix, 2)}(${classifyVixLevel(vix)})`;
  }

  const gapText = (v) => `${v >= 0 ? '+' : ''}${round(v, 1)}%`;
  const gaps = [trendGap.ndx, trendGap.spx].filter(isNum).map(Number);
  let trend = '暂无数据';
  if (gaps.length === 2) {
    const [ndx, spx] = [Number(trendGap.ndx), Number(trendGap.spx)];
    const detail = `(纳指相对200日均线 ${gapText(ndx)}、标普 ${gapText(spx)})`;
    if (ndx >= 0 && spx >= 0) trend = `指数仍处于上升趋势,站上200日均线${detail}`;
    else if (ndx < 0 && spx < 0) trend = `指数跌破200日均线,趋势转弱${detail}`;
    else trend = `两指数趋势分化${detail}`;
  } else if (gaps.length === 1) {
    const v = gaps[0];
    trend = v >= 0 ? `指数站上200日均线(${gapText(v)})` : `指数跌破200日均线(${gapText(v)})`;
  }

  return {
    valuation,
    sentiment,
    trend,
    advice: ADVICE_BY_MULTIPLIER[multiplier] || ADVICE_BY_MULTIPLIER[1],
  };
}

// ── 序列统计 ──

/** 末尾 n 个值的简单均值;样本不足返回 null */
export function smaLast(values, n) {
  const nums = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  if (!Number.isInteger(n) || n <= 0 || nums.length < n) return null;
  return nums.slice(-n).reduce((a, b) => a + b, 0) / n;
}

/** 现值相对序列末尾 n 个值最高点的百分比跌幅(≤0);样本为空返回 null */
export function dropFromRecentHigh(values, n) {
  const nums = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  if (!nums.length || !Number.isInteger(n) || n <= 0) return null;
  const tail = nums.slice(-n);
  const high = Math.max(...tail);
  if (!(high > 0)) return null;
  return ((tail[tail.length - 1] - high) / high) * 100;
}

/** 值在序列中的百分位(≤v 的占比,0–100);空序列返回 null */
export function percentileRank(values, v) {
  const nums = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  if (!nums.length || !isNum(v)) return null;
  const below = nums.filter((x) => x <= Number(v)).length;
  return (below / nums.length) * 100;
}

/** 日线 [{date:'YYYY-MM-DD', price}] → 按月均值 [{month:'YYYY-MM', avg}](升序) */
export function monthlyAverages(rows) {
  const byMonth = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const price = Number(r?.price);
    const month = typeof r?.date === 'string' ? r.date.slice(0, 7) : null;
    if (!month || !Number.isFinite(price)) continue;
    const acc = byMonth.get(month) || { sum: 0, n: 0 };
    acc.sum += price;
    acc.n += 1;
    byMonth.set(month, acc);
  }
  return [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, { sum, n }]) => ({ month, avg: sum / n }));
}

/**
 * 「过去 N 个月 VIX 与其分位」序列:对全窗口日线做月均,取末尾 N 个月,
 * 每月分位 = 该月均值在全部月均值中的百分位。返回 [{ month, vix_avg, vix_pct }]。
 */
export function vixMonthlySeries(rows, months = 6) {
  const monthly = monthlyAverages(rows);
  if (!monthly.length) return [];
  const universe = monthly.map((m) => m.avg);
  return monthly.slice(-months).map((m) => ({
    month: m.month,
    vix_avg: round(m.avg, 2),
    vix_pct: round(percentileRank(universe, m.avg), 0),
  }));
}
