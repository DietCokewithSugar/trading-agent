import { Router } from 'express';
import { supabase } from '../db.js';
import { config } from '../config.js';
import { getValuation } from '../services/portfolio.js';
import { runCycle, cycleStatus } from '../services/newsService.js';
import { sseHandler, clientCount } from '../services/bus.js';
import { getQuote } from '../services/fmp.js';

const router = Router();

function asyncHandler(fn) {
  return (req, res) => {
    fn(req, res).catch((err) => {
      console.error(`[api] ${req.path} 错误: ${err.message}`);
      res.status(500).json({ error: err.message });
    });
  };
}

router.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/** 组合概览:现金、总值、盈亏、持仓(含实时报价) */
router.get(
  '/portfolio',
  asyncHandler(async (req, res) => {
    const valuation = await getValuation();
    res.json(valuation);
  })
);

/**
 * 净值快照序列(盈亏折线图数据)。
 * ?hours=24 限定时间范围;数据库端均匀采样至 600 点(snapshots_sampled RPC)。
 */
router.get(
  '/snapshots',
  asyncHandler(async (req, res) => {
    const hours = Number(req.query.hours);
    const since =
      Number.isFinite(hours) && hours > 0
        ? new Date(Date.now() - hours * 3600_000).toISOString()
        : new Date(0).toISOString();

    const { data, error } = await supabase().rpc('snapshots_sampled', {
      since,
      max_points: 600,
    });
    if (!error) return res.json(data || []);

    // 兼容尚未执行 002 迁移的数据库:退回普通查询
    console.warn(`[api] snapshots_sampled RPC 不可用(${error.message}),退回普通查询`);
    const { data: rows, error: qErr } = await supabase()
      .from('portfolio_snapshots')
      .select('total_value, cash, positions_value, pnl, pnl_percent, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1000);
    if (qErr) throw new Error(qErr.message);
    res.json((rows || []).reverse());
  })
);

/** 组合统计:今日盈亏、已实现盈亏、胜率、最大回撤、交易次数 */
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const db = supabase();
    const [tradesRes, snapsRes] = await Promise.all([
      db
        .from('trades')
        .select('side, realized_pnl, created_at')
        .order('created_at', { ascending: false })
        .limit(1000),
      db.rpc('snapshots_sampled', { since: new Date(0).toISOString(), max_points: 600 }),
    ]);
    if (tradesRes.error) throw new Error(tradesRes.error.message);
    const trades = tradesRes.data || [];
    const snaps = snapsRes.error ? [] : snapsRes.data || [];

    const sells = trades.filter((t) => t.side === 'sell' && t.realized_pnl !== null);
    const realizedPnl = sells.reduce((sum, t) => sum + Number(t.realized_pnl), 0);
    const wins = sells.filter((t) => Number(t.realized_pnl) > 0).length;

    // 最大回撤(基于采样后的净值序列)
    let peak = -Infinity;
    let maxDrawdown = 0;
    for (const s of snaps) {
      const v = Number(s.total_value);
      if (v > peak) peak = v;
      if (peak > 0) maxDrawdown = Math.max(maxDrawdown, ((peak - v) / peak) * 100);
    }

    // 今日盈亏:最新净值 vs 美东今日首个快照之前的最后一个净值
    const etDate = (iso) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso));
    const today = etDate(new Date().toISOString());
    let baseline = null;
    for (const s of snaps) {
      if (etDate(s.created_at) < today) baseline = s;
      else break;
    }
    const latest = snaps[snaps.length - 1] || null;
    const dayPnl =
      latest && baseline ? Number(latest.total_value) - Number(baseline.total_value) : null;
    const dayPnlPercent =
      dayPnl !== null && Number(baseline.total_value) > 0
        ? (dayPnl / Number(baseline.total_value)) * 100
        : null;

    res.json({
      total_trades: trades.length,
      sell_count: sells.length,
      win_count: wins,
      win_rate: sells.length ? (wins / sells.length) * 100 : null,
      realized_pnl: realizedPnl,
      max_drawdown_percent: maxDrawdown,
      day_pnl: dayPnl,
      day_pnl_percent: dayPnlPercent,
    });
  })
);

/** 单只股票详情:报价(含盘前盘后)、持仓、相关分析、交易历史 */
router.get(
  '/symbol/:symbol',
  asyncHandler(async (req, res) => {
    const symbol = String(req.params.symbol || '').toUpperCase();
    if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
      return res.status(400).json({ error: '无效的股票代码' });
    }
    const db = supabase();
    const [quote, posRes, analysesRes, tradesRes] = await Promise.all([
      getQuote(symbol).catch(() => null),
      db.from('positions').select('*').eq('symbol', symbol).maybeSingle(),
      db
        .from('news_analyses')
        .select('*, news_articles(title, url, published_at)')
        .eq('symbol', symbol)
        .order('created_at', { ascending: false })
        .limit(50),
      db
        .from('trades')
        .select('*')
        .eq('symbol', symbol)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);
    res.json({
      symbol,
      quote,
      position: posRes.data || null,
      analyses: analysesRes.data || [],
      trades: tradesRes.data || [],
    });
  })
);

/** 交易记录(含关联新闻标题与分析) */
router.get(
  '/trades',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { data, error } = await supabase()
      .from('trades')
      .select('*, news_articles(title, url), news_analyses(sentiment, tier, reasoning)')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw new Error(error.message);
    res.json(data || []);
  })
);

/** 新闻流(含 DeepSeek 分析结果) */
router.get(
  '/news',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const onlyAnalyzed = req.query.analyzed === 'true';
    let query = supabase()
      .from('news_articles')
      .select('id, url, title, source, publisher, symbols, published_at, fetched_at, news_analyses(*)')
      .order('published_at', { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);
    if (onlyAnalyzed) {
      query = query.not('news_analyses', 'is', null);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json(data || []);
  })
);

/** SSE 实时推送流:news / analysis / trade / portfolio / snapshot / cycle 事件 */
router.get('/stream', sseHandler);

/** 调度状态 */
router.get('/status', (req, res) => {
  res.json({
    ...cycleStatus,
    pollSeconds: config.newsPollSeconds,
    quotePushSeconds: config.quotePushSeconds,
    snapshotSeconds: config.snapshotSeconds,
    riskCheckSeconds: config.riskCheckSeconds,
    sseClients: clientCount(),
    model: config.deepseekModel,
  });
});

/**
 * 手动触发一轮抓取/分析/交易(设置了 ADMIN_TOKEN 时需要鉴权)。
 * 未设置 ADMIN_TOKEN 时接口对所有人开放(首页按钮依赖此行为),
 * 但加全局冷却,防止被刷着消耗 FMP/DeepSeek 配额。
 */
const ANON_CYCLE_COOLDOWN_MS = 120_000;
let lastAnonCycleAt = 0;

router.post(
  '/run-cycle',
  asyncHandler(async (req, res) => {
    if (config.adminToken) {
      if (req.headers['x-admin-token'] !== config.adminToken) {
        return res.status(403).json({ error: '需要有效的 x-admin-token' });
      }
    } else {
      const wait = ANON_CYCLE_COOLDOWN_MS - (Date.now() - lastAnonCycleAt);
      if (wait > 0) {
        return res
          .status(429)
          .json({ error: `手动触发过于频繁,请 ${Math.ceil(wait / 1000)} 秒后再试` });
      }
    }
    if (cycleStatus.running) {
      return res.status(409).json({ error: '当前已有一轮在运行中' });
    }
    if (!config.adminToken) lastAnonCycleAt = Date.now();
    runCycle({ fullFetch: true }); // 异步执行,不阻塞响应
    res.json({ started: true });
  })
);

export default router;
