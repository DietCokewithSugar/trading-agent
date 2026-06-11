import { Router } from 'express';
import { supabase } from '../db.js';
import { config } from '../config.js';
import { getValuation } from '../services/portfolio.js';
import { runCycle, cycleStatus } from '../services/newsService.js';
import { sseHandler, clientCount } from '../services/bus.js';
import { getQuote } from '../services/fmp.js';
import { getStats, getPerformance } from '../services/statsService.js';
import { getSignalStats } from '../services/signalStats.js';
import { listPendingOrders } from '../services/openQueue.js';
import { getRegime, getRegimeParams } from '../services/macroRegime.js';
import { listRecentMacroEvents } from '../services/macroService.js';
import { getBlackoutState, getUpcomingEvents } from '../services/macroCalendar.js';
import { countByStatus, listPoolPreview } from '../services/candidateStore.js';
import { safeTokenEqual, createAuthRateLimiter } from '../services/authGuard.js';

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
    res.json(await getStats());
  })
);

/** 业绩指标:夏普比率、累计收益率、与 SPY 买入持有基准的对比 */
router.get(
  '/performance',
  asyncHandler(async (req, res) => {
    res.json(await getPerformance());
  })
);

/** 信号质量统计:前瞻收益的方向命中率/平均收益/IC,按档位/来源/置信度分桶 */
router.get(
  '/signal-stats',
  asyncHandler(async (req, res) => {
    res.json(await getSignalStats());
  })
);

/** 等待开盘成交的挂单(休市时段产生的信号) */
router.get(
  '/pending-orders',
  asyncHandler(async (req, res) => {
    res.json(await listPendingOrders());
  })
);

/** 宏观环境:当前 regime 与生效参数、近期宏观事件、经济日历/黑窗(候选池见 /api/pool) */
router.get(
  '/macro',
  asyncHandler(async (req, res) => {
    if (!config.enableMacro) {
      return res.json({ available: false });
    }
    const regime = getRegime();
    const params = getRegimeParams(regime.regime);
    const events = await listRecentMacroEvents(config.macroEventValidityHours, 20).catch(
      () => null
    );
    const blackout = getBlackoutState();
    res.json({
      available: events !== null,
      regime: {
        regime: regime.regime,
        risk_score: regime.risk_score,
        rates_signal: regime.rates_signal,
        inflation_signal: regime.inflation_signal,
        growth_signal: regime.growth_signal,
        shock_until: regime.shock_until,
        updated_at: regime.updated_at,
        params: {
          daily_buy_budget: params.dailyBuyBudget,
          min_cash_reserve: params.minCashReserve,
          max_gross_exposure: params.maxGrossExposure,
          macro_multiplier: params.macroMultiplier,
          allowed_tiers: params.allowedTiers,
        },
      },
      events: events || [],
      calendar: {
        available: blackout.available,
        blackout: {
          active: blackout.inBlackout,
          until: blackout.until,
          event: blackout.event?.event || null,
        },
        upcoming: getUpcomingEvents().map((ev) => ({
          event: ev.event,
          date: ev.date,
          estimate: ev.estimate ?? null,
          previous: ev.previous ?? null,
          actual: ev.actual ?? null,
        })),
      },
    });
  })
);

// 候选池概览(014 表缺失时返回 null,前端隐藏该卡片)
async function getPoolOverview() {
  const [counts, top] = await Promise.all([
    countByStatus().catch(() => null),
    listPoolPreview(10).catch(() => null),
  ]);
  if (counts === null && top === null) return null;
  return { counts: counts || {}, top: top || [] };
}

/** 买入候选池概览(交易记录页):等待资金分配的利好信号;池不可用时 pool 为 null */
router.get(
  '/pool',
  asyncHandler(async (req, res) => {
    res.json({ pool: config.enableMacro ? await getPoolOverview() : null });
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

/**
 * 新闻流(含分析结果)。过滤在数据库端完成,前端不再为筛选拉全量数据:
 * ?analyzed=true 只看已分析;?sentiment=bullish|bearish 按方向过滤(隐含已分析且有档位);
 * ?q=xxx 按标题/股票代码搜索。
 */
router.get(
  '/news',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const onlyAnalyzed = req.query.analyzed === 'true';
    const sentiment = ['bullish', 'bearish'].includes(req.query.sentiment)
      ? req.query.sentiment
      : null;
    // 搜索词只保留安全字符,避免拼入 PostgREST or 过滤器时产生语法歧义
    const q = String(req.query.q || '')
      .trim()
      .slice(0, 40)
      .replace(/[%,()."'\\{}]/g, '');

    const buildQuery = (cols) => {
      // sentiment 过滤需要 inner join,否则嵌套过滤只清空子数组、不过滤父行
      let query = supabase()
        .from('news_articles')
        .select(`${cols}, ${sentiment ? 'news_analyses!inner(*)' : 'news_analyses(*)'}`)
        .order('published_at', { ascending: false, nullsFirst: false })
        .range(offset, offset + limit - 1);
      if (sentiment) {
        query = query
          .eq('news_analyses.sentiment', sentiment)
          .not('news_analyses.tier', 'is', null);
      } else if (onlyAnalyzed) {
        query = query.not('news_analyses', 'is', null);
      }
      if (q) {
        query = query.or(`title.ilike.%${q}%,symbols.cs.{${q.toUpperCase()}}`);
      }
      return query;
    };

    let { data, error } = await buildQuery(
      'id, url, title, source, publisher, source_domain, source_score, symbols, published_at, fetched_at'
    );
    // 兼容尚未执行 009 迁移的数据库:去掉来源可信度列重试
    if (error && /source_domain|source_score/.test(error.message)) {
      ({ data, error } = await buildQuery(
        'id, url, title, source, publisher, symbols, published_at, fetched_at'
      ));
    }
    if (error) throw new Error(error.message);
    res.json(data || []);
  })
);

/** SSE 实时推送流:news / analysis / trade / portfolio / snapshot / cycle / macro 事件 */
router.get('/stream', sseHandler);

/** 调度状态(公开接口,不暴露模型等内部配置;完整状态见 /api/admin/status) */
router.get('/status', (req, res) => {
  res.json({
    ...cycleStatus,
    pollSeconds: config.newsPollSeconds,
    quotePushSeconds: config.quotePushSeconds,
    snapshotSeconds: config.snapshotSeconds,
    riskCheckSeconds: config.riskCheckSeconds,
    sseClients: clientCount(),
  });
});

/**
 * 手动触发一轮抓取/分析/交易(设置了 ADMIN_TOKEN 时需要鉴权)。
 * 未设置 ADMIN_TOKEN 时接口对所有人开放(供外部定时服务在 Render Free
 * 计划休眠时代替内置定时器),但加全局冷却,防止被刷着消耗 API 配额。
 * 站内的手动触发入口在管理页(#/admin → /api/admin/run-cycle)。
 */
const ANON_CYCLE_COOLDOWN_MS = 120_000;
let lastAnonCycleAt = 0;

router.post(
  '/run-cycle',
  createAuthRateLimiter('api'),
  asyncHandler(async (req, res) => {
    if (config.adminToken) {
      if (!safeTokenEqual(req.headers['x-admin-token'], config.adminToken)) {
        console.warn(`[api] x-admin-token 校验失败 ip=${req.ip} path=${req.path}`);
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
    runCycle({ fullFetch: true, trigger: 'manual' }); // 异步执行,不阻塞响应
    res.json({ started: true });
  })
);

export default router;
