import { supabase } from '../db.js';
import { isPressRelease } from './credibility.js';

/**
 * 信号质量统计:基于前瞻收益(signalReturns.js 回填)评估"分类信号本身"的预测能力,
 * 与仓位、止损、组合表现解耦。覆盖全部记录了信号价的非中性分析,
 * 包括因事件去重/置信度不足而未实际交易的信号。
 *
 * 口径说明:
 *  - 前瞻收益按信号方向调整:利空信号取负,正值即"方向判对";
 *  - 命中率 = 方向调整收益 > 0 的比例(收益恰为 0 计为未命中),
 *    并附 Wilson 95% 置信区间——小样本的命中率区间很宽,防止 20 条样本就下结论;
 *  - IC = 综合置信度与方向调整收益的皮尔逊相关系数(信号强度是否预测收益幅度);
 *  - 机会成本:被各拦截层(资金受限/宏观过滤/冲突搁置/风控官否决)拦下的信号
 *    同样记录了前瞻收益——被拦信号若持续大涨说明该层过度保守,若大跌说明该层有价值。
 *
 * 时间窗口:?days= 限定统计窗口(默认全量),分页拉取突破 PostgREST 单次
 * 1000 行上限,超过 MAX_SAMPLE_ROWS 时截断并在响应里明示(window.truncated)。
 */

const HORIZONS = ['1h', '1d', '5d'];
const PAGE_SIZE = 1000;
const MAX_SAMPLE_ROWS = 5000;

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** 皮尔逊相关系数;样本不足或零方差返回 null */
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3 || n !== ys.length) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return null;
  return cov / Math.sqrt(vx * vy);
}

/**
 * 命中率的 Wilson 95% 置信区间(返回百分比 { lo, hi });n=0 返回 null。
 * 用 Wilson 而非正态近似:小样本与命中率接近 0/1 时正态区间会越界且过窄。
 */
export function wilsonInterval(hits, n, z = 1.96) {
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    lo: round(Math.max(center - margin, 0) * 100, 1),
    hi: round(Math.min(center + margin, 1) * 100, 1),
  };
}

/** 一组信号在三个前瞻口径上的样本量/命中率(含 95% 置信区间)/平均方向调整收益 */
function horizonMetrics(rows) {
  const out = {};
  for (const h of HORIZONS) {
    const adj = rows
      .map((r) => r[`adj_${h}`])
      .filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    const hits = adj.filter((v) => v > 0).length;
    const ci = wilsonInterval(hits, adj.length);
    out[`n_${h}`] = adj.length;
    out[`hit_${h}`] = adj.length ? round((hits / adj.length) * 100) : null;
    out[`hit_lo_${h}`] = ci ? ci.lo : null;
    out[`hit_hi_${h}`] = ci ? ci.hi : null;
    out[`avg_${h}`] = adj.length ? round(adj.reduce((a, b) => a + b, 0) / adj.length, 3) : null;
  }
  return out;
}

function bucketRows(rows, buckets) {
  return buckets
    .map(({ label, match }) => {
      const subset = rows.filter(match);
      return { label, ...horizonMetrics(subset) };
    })
    .filter((r) => HORIZONS.some((h) => r[`n_${h}`] > 0));
}

/**
 * 纯聚合(可单测):rows 为
 * { sentiment, tier, confidence, final_confidence, source_score, traded,
 *   candidate_status, macro_regime, pool_wait_minutes, pool_drift_percent,
 *   fwd_return_1h, fwd_return_1d, fwd_return_5d }
 */
export function summarizeSignals(rows) {
  // 预计算方向调整收益
  const enriched = rows.map((r) => {
    const dir = r.sentiment === 'bearish' ? -1 : 1;
    const adj = (v) =>
      v === null || v === undefined || !Number.isFinite(Number(v)) ? null : dir * Number(v);
    return {
      ...r,
      adj_1h: adj(r.fwd_return_1h),
      adj_1d: adj(r.fwd_return_1d),
      adj_5d: adj(r.fwd_return_5d),
    };
  });

  const num = (v) => (v === null || v === undefined ? null : Number(v));

  const groups = [
    {
      key: 'overall',
      label: '全部信号',
      rows: bucketRows(enriched, [
        { label: '全部', match: () => true },
        { label: '利好', match: (r) => r.sentiment === 'bullish' },
        { label: '利空', match: (r) => r.sentiment === 'bearish' },
      ]),
    },
    {
      key: 'tier',
      label: '按事件档位',
      rows: bucketRows(
        enriched,
        [1, 2, 3, 4].map((t) => ({ label: `第${t}档`, match: (r) => r.tier === t }))
      ),
    },
    {
      key: 'source',
      label: '按来源可信度',
      rows: bucketRows(enriched, [
        { label: '高(≥0.85)', match: (r) => num(r.source_score) !== null && num(r.source_score) >= 0.85 },
        {
          label: '中(0.65~0.85)',
          match: (r) => {
            const s = num(r.source_score);
            return s !== null && s >= 0.65 && s < 0.85;
          },
        },
        { label: '低(<0.65)', match: (r) => num(r.source_score) !== null && num(r.source_score) < 0.65 },
        { label: '未知', match: (r) => num(r.source_score) === null },
      ]),
    },
    {
      key: 'confidence',
      label: '按分析置信度(校准)',
      rows: bucketRows(enriched, [
        { label: '<0.6', match: (r) => num(r.confidence) !== null && num(r.confidence) < 0.6 },
        {
          label: '0.6~0.7',
          match: (r) => {
            const c = num(r.confidence);
            return c !== null && c >= 0.6 && c < 0.7;
          },
        },
        {
          label: '0.7~0.8',
          match: (r) => {
            const c = num(r.confidence);
            return c !== null && c >= 0.7 && c < 0.8;
          },
        },
        {
          label: '0.8~0.9',
          match: (r) => {
            const c = num(r.confidence);
            return c !== null && c >= 0.8 && c < 0.9;
          },
        },
        { label: '≥0.9', match: (r) => num(r.confidence) !== null && num(r.confidence) >= 0.9 },
      ]),
    },
    {
      // 拦截层机会成本:被各层拦下的信号同样回填前瞻收益——
      // 与「已交易」基准对比,被拦信号持续走高说明该层过度保守(拦掉了 alpha),
      // 走低说明该层有价值(躲过了亏损)。风控官否决目前只覆盖分配路径
      // (候选 rejected 且理由以"风控官"开头);即时路径的否决无落库记录。
      key: 'traded',
      label: '实际交易 vs 拦截层(机会成本)',
      rows: bucketRows(enriched, [
        { label: '已交易', match: (r) => r.traded },
        {
          label: '资金受限未交易',
          match: (r) => !r.traded && r.candidate_status === 'capital_constrained',
        },
        { label: '宏观过滤', match: (r) => !r.traded && r.candidate_status === 'macro_filtered' },
        { label: '冲突搁置', match: (r) => !r.traded && r.candidate_status === 'conflict_hold' },
        { label: '风控官否决', match: (r) => !r.traded && r.officer_veto },
        {
          label: '候选过期/取消',
          match: (r) =>
            !r.traded && !r.officer_veto && ['expired', 'cancelled'].includes(r.candidate_status),
        },
        {
          label: '其他未交易(去重/挂起/否决)',
          match: (r) =>
            !r.traded &&
            !r.officer_veto &&
            !['capital_constrained', 'macro_filtered', 'conflict_hold', 'expired', 'cancelled'].includes(
              r.candidate_status
            ),
        },
      ]),
    },
    {
      // 入池时的宏观环境快照(candidate_signals.macro_regime,014):
      // 回答"避险/冲击状态下信号命中率是否真的更差"——验证宏观层价值的证据链
      key: 'regime',
      label: '按宏观环境(入池时)',
      rows: bucketRows(enriched, [
        { label: '风险偏好', match: (r) => r.macro_regime === 'risk_on' },
        { label: '中性', match: (r) => r.macro_regime === 'neutral' },
        { label: '避险', match: (r) => r.macro_regime === 'risk_off' },
        { label: '宏观冲击', match: (r) => r.macro_regime === 'macro_shock' },
        { label: '未入池', match: (r) => !r.macro_regime },
      ]),
    },
    {
      // 排队成本(trades.pool_wait_minutes,016):候选池把买入延迟了,
      // 对比即时/入池路径与不同等待时长的 1h 前瞻收益,量化延迟丢掉的 alpha
      key: 'exec_path',
      label: '执行路径与排队时长(已成交)',
      rows: bucketRows(enriched, [
        { label: '即时成交', match: (r) => r.traded && num(r.pool_wait_minutes) === null },
        { label: '入池成交(全部)', match: (r) => r.traded && num(r.pool_wait_minutes) !== null },
        {
          label: '入池 ≤15 分钟',
          match: (r) => {
            const w = num(r.pool_wait_minutes);
            return r.traded && w !== null && w <= 15;
          },
        },
        {
          label: '入池 15~60 分钟',
          match: (r) => {
            const w = num(r.pool_wait_minutes);
            return r.traded && w !== null && w > 15 && w <= 60;
          },
        },
        {
          label: '入池 1~4 小时',
          match: (r) => {
            const w = num(r.pool_wait_minutes);
            return r.traded && w !== null && w > 60 && w <= 240;
          },
        },
        {
          label: '入池 >4 小时',
          match: (r) => {
            const w = num(r.pool_wait_minutes);
            return r.traded && w !== null && w > 240;
          },
        },
      ]),
    },
  ];

  // 排队成本总览:入池路径成交信号的平均等待时长与平均入池→成交价格漂移
  const pooledFilled = enriched.filter((r) => r.traded && num(r.pool_wait_minutes) !== null);
  const waits = pooledFilled.map((r) => num(r.pool_wait_minutes)).filter((v) => Number.isFinite(v));
  const drifts = pooledFilled
    .map((r) => num(r.pool_drift_percent))
    .filter((v) => v !== null && Number.isFinite(v));
  const pooling = {
    n: pooledFilled.length,
    avg_wait_minutes: waits.length ? round(waits.reduce((a, b) => a + b, 0) / waits.length, 1) : null,
    avg_drift_percent: drifts.length
      ? round(drifts.reduce((a, b) => a + b, 0) / drifts.length, 3)
      : null,
  };

  // IC:综合置信度 vs 方向调整收益
  const ic = {};
  for (const h of HORIZONS) {
    const pairs = enriched.filter(
      (r) => r[`adj_${h}`] !== null && num(r.final_confidence) !== null
    );
    const value = pearson(
      pairs.map((r) => num(r.final_confidence)),
      pairs.map((r) => r[`adj_${h}`])
    );
    ic[h] = value === null ? null : round(value, 3);
  }

  return {
    total: rows.length,
    traded_count: rows.filter((r) => r.traded).length,
    groups,
    ic,
    pooling,
  };
}

/**
 * 卖单配对源头买入信号(纯函数):止损/止盈/持有超时等自动卖单不带 analysis_id,
 * 按"同票中 created_at 最近且不晚于卖出时间的买单"回溯其信号来源。
 * sells = [{ symbol, trigger, realized_pnl, created_at }],
 * buys = [{ symbol, analysis_id, created_at }](须为买单)。
 * 返回配对成功的 [{ ...sell, analysis_id }],配不上的丢弃。
 */
export function pairSellsToBuys(sells, buys) {
  const buysBySymbol = new Map();
  for (const b of buys || []) {
    if (!b?.symbol || b.analysis_id === null || b.analysis_id === undefined) continue;
    const list = buysBySymbol.get(b.symbol) || [];
    list.push(b);
    buysBySymbol.set(b.symbol, list);
  }
  // 每票按时间倒序,配对时取第一个不晚于卖出时间的买单
  for (const list of buysBySymbol.values()) {
    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  const paired = [];
  for (const s of sells || []) {
    const list = buysBySymbol.get(s?.symbol);
    if (!list) continue;
    const sellTs = new Date(s.created_at).getTime();
    const buy = list.find((b) => new Date(b.created_at).getTime() <= sellTs);
    if (buy) paired.push({ ...s, analysis_id: buy.analysis_id });
  }
  return paired;
}

/**
 * 实盘兑现聚合(纯函数,±2%/48h 策略口径):每笔已平仓卖单按源信号维度分桶,
 * 统计离场触发分布(止盈/止损/持有超时/其他)与已实现盈亏。
 * rows = [{ trigger, realized_pnl, tier, source_score, is_press, is_filing }]。
 * 直接回答"哪类信号在固定敞口+持有时限的规则下真能兑现到止盈"。
 */
export function summarizeTradeOutcomes(rows) {
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  const buckets = [
    { label: '全部', match: () => true },
    { label: '第1档', match: (r) => r.tier === 1 },
    { label: '第2档', match: (r) => r.tier === 2 },
    { label: '来源高(≥0.85)', match: (r) => num(r.source_score) !== null && num(r.source_score) >= 0.85 },
    {
      label: '来源中(0.65~0.85)',
      match: (r) => {
        const s = num(r.source_score);
        return s !== null && s >= 0.65 && s < 0.85;
      },
    },
    { label: '来源低(<0.65)', match: (r) => num(r.source_score) !== null && num(r.source_score) < 0.65 },
    { label: '新闻稿来源', match: (r) => r.is_press === true },
    // 监管披露(SEC 8-K)与新闻稿分开观测:同属公司自述,但可信档不同,证据链互不污染
    { label: '监管披露来源', match: (r) => r.is_filing === true },
  ];
  const pct = (part, n) => (n ? round((part / n) * 100, 1) : null);
  const out = buckets
    .map(({ label, match }) => {
      const subset = (rows || []).filter(match);
      const n = subset.length;
      const byTrigger = (t) => subset.filter((r) => r.trigger === t).length;
      const wins = subset.filter((r) => Number(r.realized_pnl) > 0).length;
      const pnls = subset.map((r) => Number(r.realized_pnl)).filter((v) => Number.isFinite(v));
      const totalPnl = pnls.reduce((a, b) => a + b, 0);
      const ci = wilsonInterval(wins, n);
      return {
        label,
        n,
        take_profit_rate: pct(byTrigger('take_profit'), n),
        stop_loss_rate: pct(byTrigger('stop_loss'), n),
        max_hold_rate: pct(byTrigger('max_hold'), n),
        other_rate: pct(n - byTrigger('take_profit') - byTrigger('stop_loss') - byTrigger('max_hold'), n),
        win_rate: pct(wins, n),
        win_lo: ci ? ci.lo : null,
        win_hi: ci ? ci.hi : null,
        avg_pnl: pnls.length ? round(totalPnl / pnls.length, 2) : null,
        total_pnl: pnls.length ? round(totalPnl, 2) : null,
      };
    })
    .filter((b) => b.n > 0);
  return { total: (rows || []).length, buckets: out };
}

/**
 * 分页拉取(突破 PostgREST 单次 1000 行上限):buildQuery 每次返回新查询,
 * 按 PAGE_SIZE 翻页直到取尽或达到 maxRows。返回 { rows, truncated, error }
 * (error 为首个失败页的 supabase 错误,调用方按迁移容忍逻辑处理)。
 */
async function fetchPaged(buildQuery, maxRows = MAX_SAMPLE_ROWS) {
  const rows = [];
  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) return { rows, truncated: false, error };
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return { rows, truncated: false, error: null };
  }
  return { rows, truncated: true, error: null };
}

/**
 * 加载评估层原始行(getSignalStats 与参数建议器共用):每行一条非中性信号,
 * 带前瞻收益、成交/候选状态、排队度量与来源信息。011 未迁移时返回 null。
 * days 限定窗口(null=全量,受 MAX_SAMPLE_ROWS 截断)。
 */
export async function loadSignalRows({ days = null } = {}) {
  const db = supabase();
  const since =
    Number.isFinite(days) && days > 0 ? new Date(Date.now() - days * 86400_000).toISOString() : null;
  const withSince = (q) => (since ? q.gte('created_at', since) : q);

  // 只取"至少一个口径已回填"的有效行:未回填的新信号(1d/5d 结构性未到期)对统计是纯噪音,
  // 却会按时间倒序把 MAX_SAMPLE_ROWS 的样本预算全部挤占——信号量涨到 ~千条/天后,
  // 5000 条只够覆盖几天,页面上 1d/5d 样本直接归零。预算只花在有效行上,覆盖窗口自然拉长
  const analysesFetch = await fetchPaged(() =>
    withSince(
      db
        .from('news_analyses')
        .select(
          'id, symbol, sentiment, tier, confidence, final_confidence, signal_price, fwd_return_1h, fwd_return_1d, fwd_return_5d, created_at, news_articles(source_score, source, source_domain, url)'
        )
        .not('signal_price', 'is', null)
        .or('fwd_return_1h.not.is.null,fwd_return_1d.not.is.null,fwd_return_5d.not.is.null')
        .in('sentiment', ['bullish', 'bearish'])
        .order('created_at', { ascending: false })
    )
  );
  if (analysesFetch.error) {
    if (/signal_price|fwd_return/.test(analysesFetch.error.message)) {
      return null;
    }
    throw new Error(analysesFetch.error.message);
  }
  const data = analysesFetch.rows;

  // 实际成交的分析集合(买卖都算)+ 排队成本(016 迁移容忍:缺 pool_* 列退回只取 analysis_id)。
  // 同窗口过滤 + 时间倒序:全量截断时优先保住与最近分析对齐的成交
  let tradeRows = [];
  {
    const full = await fetchPaged(() =>
      withSince(
        db
          .from('trades')
          .select('analysis_id, symbol, side, pool_wait_minutes, pool_drift_percent, created_at')
          .not('analysis_id', 'is', null)
          .order('created_at', { ascending: false })
      )
    );
    if (full.error && /pool_|column|schema/i.test(full.error.message)) {
      const basic = await fetchPaged(() =>
        withSince(
          db
            .from('trades')
            .select('analysis_id, symbol, side, created_at')
            .not('analysis_id', 'is', null)
            .order('created_at', { ascending: false })
        )
      );
      // 缺列之外的失败同样不可吞:静默用空集会把全部信号标成"未交易"
      if (basic.error) throw new Error(basic.error.message);
      tradeRows = basic.rows;
    } else if (full.error) {
      // 非缺列类失败(网络/超时):不能拿部分/空结果继续——
      // 全部信号会被静默标成"未交易",机会成本统计整组失真
      throw new Error(full.error.message);
    } else {
      tradeRows = full.rows;
    }
  }
  const tradedSet = new Set(tradeRows.map((t) => t.analysis_id));
  // 入池路径成交的排队度量(只看买入;同一分析多笔成交取首个有度量的)
  const poolByAnalysis = new Map();
  for (const t of tradeRows) {
    if (t.side && t.side !== 'buy') continue;
    if (t.pool_wait_minutes === null || t.pool_wait_minutes === undefined) continue;
    if (!poolByAnalysis.has(t.analysis_id)) {
      poolByAnalysis.set(t.analysis_id, {
        wait: Number(t.pool_wait_minutes),
        drift: t.pool_drift_percent === null || t.pool_drift_percent === undefined ? null : Number(t.pool_drift_percent),
      });
    }
  }

  // 候选池状态 + 入池时宏观快照 + 状态理由(014 迁移容忍:表缺失时全部按 null,相关分组自然为空)。
  // status_reason 用于识别分配路径的风控官否决(rejected 且理由以"风控官"开头)。
  // 022 同票合并后,被合并事件的 analysis 不再有自己的候选行(candidate_status 为 null,
  // 不进 traded-vs-blocked 分桶)——候选行只代表每票最强的那条信号,口径的已知取舍
  let candidateById = new Map();
  try {
    const candFetch = await fetchPaged(() =>
      withSince(
        db
          .from('candidate_signals')
          .select('analysis_id, status, status_reason, macro_regime, created_at')
          .not('analysis_id', 'is', null)
          .order('created_at', { ascending: false })
      )
    );
    if (!candFetch.error) {
      candidateById = new Map(candFetch.rows.map((c) => [c.analysis_id, c]));
    }
  } catch {
    // 候选池不可用时静默退回(本统计是纯观测层)
  }

  // 实盘兑现(±2%/48h 策略口径):已平仓卖单配对源头买入信号,统计离场触发分布与已实现盈亏。
  // 止损/止盈/持有超时等自动卖单不带 analysis_id(上面的 trades 查询过滤掉了),
  // 单独取卖单再按"同票最近买单"回溯。纯观测口径,失败只降级不抛出
  let outcomeRows = [];
  try {
    const sellsFetch = await fetchPaged(() =>
      withSince(
        db
          .from('trades')
          .select('symbol, trigger, realized_pnl, created_at')
          .eq('side', 'sell')
          .not('realized_pnl', 'is', null)
          .order('created_at', { ascending: false })
      )
    );
    if (!sellsFetch.error && sellsFetch.rows.length) {
      const buys = tradeRows.filter((t) => t.side === 'buy' && t.symbol);
      const paired = pairSellsToBuys(sellsFetch.rows, buys);
      // 批量反查配对买入的分析行,补齐档位/来源维度(卖单量级小,分批 in 查询)
      const ids = [...new Set(paired.map((p) => p.analysis_id))];
      const dimById = new Map();
      for (let i = 0; i < ids.length; i += 500) {
        const { data: dims } = await db
          .from('news_analyses')
          .select('id, tier, sentiment, news_articles(source_score, source, source_domain, url)')
          .in('id', ids.slice(i, i + 500));
        for (const d of dims || []) dimById.set(d.id, d);
      }
      outcomeRows = paired.map((p) => {
        const dim = dimById.get(p.analysis_id);
        const article = dim?.news_articles || {};
        return {
          trigger: p.trigger,
          realized_pnl: Number(p.realized_pnl),
          tier: dim?.tier ?? null,
          source_score:
            article.source_score === null || article.source_score === undefined
              ? null
              : Number(article.source_score),
          is_press: dim ? isPressRelease(article) : false,
          is_filing: dim ? article.source === 'sec-filings' : false,
        };
      });
    }
  } catch (err) {
    console.warn(`[signal] 实盘兑现统计加载失败(其余口径不受影响): ${err.message}`);
  }

  const rows = (data || []).map((a) => {
    const cand = candidateById.get(a.id);
    const article = a.news_articles || {};
    return {
      sentiment: a.sentiment,
      tier: a.tier,
      confidence: a.confidence === null ? null : Number(a.confidence),
      final_confidence: a.final_confidence === null ? null : Number(a.final_confidence),
      source_score:
        article.source_score === null || article.source_score === undefined
          ? null
          : Number(article.source_score),
      // 公司公告类来源(新闻稿通道):参数建议器评估 PRESS_BULLISH_PENALTY 用
      is_press: isPressRelease(article),
      // 监管披露来源(SEC 8-K):单独观测,不混入 is_press 口径
      is_filing: article.source === 'sec-filings',
      traded: tradedSet.has(a.id),
      candidate_status: cand?.status ?? null,
      officer_veto: cand?.status === 'rejected' && /^风控官/.test(cand?.status_reason || ''),
      macro_regime: cand?.macro_regime ?? null,
      pool_wait_minutes: poolByAnalysis.get(a.id)?.wait ?? null,
      pool_drift_percent: poolByAnalysis.get(a.id)?.drift ?? null,
      fwd_return_1h: a.fwd_return_1h === null ? null : Number(a.fwd_return_1h),
      fwd_return_1d: a.fwd_return_1d === null ? null : Number(a.fwd_return_1d),
      fwd_return_5d: a.fwd_return_5d === null ? null : Number(a.fwd_return_5d),
    };
  });

  return {
    rows,
    outcomeRows,
    window: {
      days: since ? days : null,
      since,
      max_rows: MAX_SAMPLE_ROWS,
      truncated: analysesFetch.truncated,
      // 截断时实际覆盖到的最早信号时间(时间倒序,最后一行最旧;仅计已回填的有效行)
      covered_since: data.length ? data[data.length - 1].created_at : null,
    },
  };
}

/**
 * /api/signal-stats 的数据来源;011 迁移未执行时返回 { available: false }。
 * days 限定统计窗口(美东无关,按 UTC 时间差;null=全量,但受 MAX_SAMPLE_ROWS 截断,
 * 截断时 window.truncated=true 且 window.covered_since 给出实际覆盖到的最早信号时间)。
 */
export async function getSignalStats({ days = null } = {}) {
  const loaded = await loadSignalRows({ days });
  if (!loaded) return { available: false };
  return {
    available: true,
    generated_at: new Date().toISOString(),
    window: loaded.window,
    ...summarizeSignals(loaded.rows),
    // 实盘兑现(±2%/48h 离场规则下的信号兑现质量):止盈/止损/超时分布 + 已实现盈亏
    outcomes: summarizeTradeOutcomes(loaded.outcomeRows),
  };
}
