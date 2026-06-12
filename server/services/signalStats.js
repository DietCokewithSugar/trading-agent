import { supabase } from '../db.js';

/**
 * 信号质量统计:基于前瞻收益(signalReturns.js 回填)评估"分类信号本身"的预测能力,
 * 与仓位、止损、组合表现解耦。覆盖全部记录了信号价的非中性分析,
 * 包括因事件去重/置信度不足而未实际交易的信号。
 *
 * 口径说明:
 *  - 前瞻收益按信号方向调整:利空信号取负,正值即"方向判对";
 *  - 命中率 = 方向调整收益 > 0 的比例(收益恰为 0 计为未命中);
 *  - IC = 综合置信度与方向调整收益的皮尔逊相关系数(信号强度是否预测收益幅度)。
 */

const HORIZONS = ['1h', '1d', '5d'];

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

/** 一组信号在三个前瞻口径上的样本量/命中率/平均方向调整收益 */
function horizonMetrics(rows) {
  const out = {};
  for (const h of HORIZONS) {
    const adj = rows
      .map((r) => r[`adj_${h}`])
      .filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    const hits = adj.filter((v) => v > 0).length;
    out[`n_${h}`] = adj.length;
    out[`hit_${h}`] = adj.length ? round((hits / adj.length) * 100) : null;
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
      key: 'traded',
      label: '实际交易 vs 未交易',
      rows: bucketRows(enriched, [
        { label: '已交易', match: (r) => r.traded },
        // 候选池状态细分(014):资金受限/宏观过滤/冲突搁置说明"信号好但没轮到钱/被组合层拦下",
        // 它们的前瞻收益是衡量分配器机会成本的关键
        {
          label: '资金受限未交易',
          match: (r) => !r.traded && r.candidate_status === 'capital_constrained',
        },
        { label: '宏观过滤', match: (r) => !r.traded && r.candidate_status === 'macro_filtered' },
        { label: '冲突搁置', match: (r) => !r.traded && r.candidate_status === 'conflict_hold' },
        {
          label: '其他未交易(去重/挂起/否决)',
          match: (r) =>
            !r.traded &&
            !['capital_constrained', 'macro_filtered', 'conflict_hold'].includes(
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

/** /api/signal-stats 的数据来源;011 迁移未执行时返回 { available: false } */
export async function getSignalStats() {
  const db = supabase();
  const { data, error } = await db
    .from('news_analyses')
    .select(
      'id, symbol, sentiment, tier, confidence, final_confidence, signal_price, fwd_return_1h, fwd_return_1d, fwd_return_5d, created_at, news_articles(source_score)'
    )
    .not('signal_price', 'is', null)
    .in('sentiment', ['bullish', 'bearish'])
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) {
    if (/signal_price|fwd_return/.test(error.message)) {
      return { available: false };
    }
    throw new Error(error.message);
  }

  // 实际成交的分析集合(买卖都算)+ 排队成本(016 迁移容忍:缺 pool_* 列退回只取 analysis_id)
  let tradeRows = [];
  {
    const { data: tRows, error: tErr } = await db
      .from('trades')
      .select('analysis_id, side, pool_wait_minutes, pool_drift_percent')
      .not('analysis_id', 'is', null)
      .limit(2000);
    if (tErr && /pool_|column|schema/i.test(tErr.message)) {
      const { data: basic } = await db
        .from('trades')
        .select('analysis_id')
        .not('analysis_id', 'is', null)
        .limit(2000);
      tradeRows = basic || [];
    } else {
      tradeRows = tRows || [];
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

  // 候选池状态 + 入池时宏观快照(014 迁移容忍:表缺失时全部按 null,相关分组自然为空)
  let candidateById = new Map();
  try {
    const { data: candRows, error: candErr } = await db
      .from('candidate_signals')
      .select('analysis_id, status, macro_regime')
      .not('analysis_id', 'is', null)
      .limit(2000);
    if (!candErr) {
      candidateById = new Map((candRows || []).map((c) => [c.analysis_id, c]));
    }
  } catch {
    // 候选池不可用时静默退回(本统计是纯观测层)
  }

  const rows = (data || []).map((a) => ({
    sentiment: a.sentiment,
    tier: a.tier,
    confidence: a.confidence === null ? null : Number(a.confidence),
    final_confidence: a.final_confidence === null ? null : Number(a.final_confidence),
    source_score:
      a.news_articles?.source_score === null || a.news_articles?.source_score === undefined
        ? null
        : Number(a.news_articles.source_score),
    traded: tradedSet.has(a.id),
    candidate_status: candidateById.get(a.id)?.status ?? null,
    macro_regime: candidateById.get(a.id)?.macro_regime ?? null,
    pool_wait_minutes: poolByAnalysis.get(a.id)?.wait ?? null,
    pool_drift_percent: poolByAnalysis.get(a.id)?.drift ?? null,
    fwd_return_1h: a.fwd_return_1h === null ? null : Number(a.fwd_return_1h),
    fwd_return_1d: a.fwd_return_1d === null ? null : Number(a.fwd_return_1d),
    fwd_return_5d: a.fwd_return_5d === null ? null : Number(a.fwd_return_5d),
  }));

  return { available: true, generated_at: new Date().toISOString(), ...summarizeSignals(rows) };
}
