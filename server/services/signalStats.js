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
        { label: '未交易(去重/挂起/否决)', match: (r) => !r.traded },
      ]),
    },
  ];

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

  // 实际成交的分析集合(买卖都算)
  const { data: tradedRows } = await db
    .from('trades')
    .select('analysis_id')
    .not('analysis_id', 'is', null)
    .limit(2000);
  const tradedSet = new Set((tradedRows || []).map((t) => t.analysis_id));

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
    fwd_return_1h: a.fwd_return_1h === null ? null : Number(a.fwd_return_1h),
    fwd_return_1d: a.fwd_return_1d === null ? null : Number(a.fwd_return_1d),
    fwd_return_5d: a.fwd_return_5d === null ? null : Number(a.fwd_return_5d),
  }));

  return { available: true, generated_at: new Date().toISOString(), ...summarizeSignals(rows) };
}
