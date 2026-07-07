import { Router } from 'express';
import { supabase } from '../db.js';
import { config } from '../config.js';
import { getValuation } from '../services/portfolio.js';
import { runCycle, cycleStatus } from '../services/newsService.js';
import { sseHandler, clientCount } from '../services/bus.js';
import { getQuote, getQuotes, getMarketSession, quoteDisplayFields } from '../services/fmp.js';
import { CLOSED_QUOTE_MAX_AGE_MS } from '../services/quotesPush.js';
import { getStats, getPerformance } from '../services/statsService.js';
import { getSignalStats } from '../services/signalStats.js';
import { listPendingOrders } from '../services/openQueue.js';
import { getEffectiveRegime } from '../services/macroRegime.js';
import { listRecentMacroEvents } from '../services/macroService.js';
import { getBlackoutState, getUpcomingEvents } from '../services/macroCalendar.js';
import { countByStatus, listPoolPreview } from '../services/candidateStore.js';
import { getShadowOverview, getShadowTrades } from '../services/shadowPortfolio.js';
import { getBrokerMirrorOverview } from '../services/brokerMirror.js';
import { isVolBracketEnabled, getTradingStrategy, strategyBracket } from '../services/strategy.js';
import { getPrimaryValuation, isBrokerLedgerPrimary } from '../services/primaryLedger.js';
import { getBrokerSnapshots } from '../services/brokerMirror.js';
import { safeTokenEqual, createAuthRateLimiter } from '../services/authGuard.js';
import { clusterAnalyses } from '../services/newsDedup.js';

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

/** 组合概览:现金、总值、盈亏、持仓(含实时报价);主账本开关(024)决定数据源 */
router.get(
  '/portfolio',
  asyncHandler(async (req, res) => {
    const valuation = await getPrimaryValuation();
    res.json(valuation);
  })
);

/**
 * 净值快照序列(盈亏折线图数据)。
 * ?hours=24 限定时间范围;数据库端均匀采样至 600 点(snapshots_sampled RPC)。
 * 主账本为券商模拟(024)时改用券商净值快照序列(取数失败回退内部序列,fail-open)。
 */
router.get(
  '/snapshots',
  asyncHandler(async (req, res) => {
    const hours = Number(req.query.hours);
    const since =
      Number.isFinite(hours) && hours > 0
        ? new Date(Date.now() - hours * 3600_000).toISOString()
        : new Date(0).toISOString();

    if (isBrokerLedgerPrimary()) {
      try {
        return res.json(await getBrokerSnapshots(since));
      } catch (err) {
        console.warn(`[api] 券商净值序列不可用,回退内部快照: ${err.message}`);
      }
    }

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

/**
 * 信号质量统计:前瞻收益的方向命中率(含 95% 置信区间)/平均收益/IC,
 * 按档位/来源/置信度/拦截层(机会成本)分桶。?days=7|30 限定统计窗口(缺省全量,
 * 超过采样上限时截断并在 window.truncated 标明)。
 */
router.get(
  '/signal-stats',
  asyncHandler(async (req, res) => {
    const days = Number(req.query.days);
    res.json(
      await getSignalStats({
        days: Number.isFinite(days) && days > 0 ? Math.min(days, 366) : null,
      })
    );
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
    // 生效参数 = 新闻 regime ∩ 确定性市场核验(016):核验不同向时 risk_on 放大被钳制
    const regime = getEffectiveRegime();
    const params = regime.params;
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
        effective_regime: regime.effective_regime,
        clamped: regime.clamped,
        params: {
          daily_buy_budget: params.dailyBuyBudget,
          min_cash_reserve: params.minCashReserve,
          max_gross_exposure: params.maxGrossExposure,
          macro_multiplier: params.macroMultiplier,
          allowed_tiers: params.allowedTiers,
        },
      },
      // 确定性市场核验状态(纯市场数据,无供应商信息,可公开)
      market_check: {
        available: regime.market_check?.available || false,
        trend: regime.market_check?.trend || null,
        spy_price: regime.market_check?.spyPrice ?? null,
        sma20: regime.market_check?.sma20 ?? null,
        vix: regime.market_check?.vix ?? null,
        fetched_at: regime.market_check?.fetchedAt ?? null,
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

  // 现价富化(fail-open,报价失败仅缺现价相关字段):
  // "若现在买入"的止盈止损参考只能锚定现价——入池价是另一个问题的答案
  // (反事实:系统若在入池瞬间买入,这笔仓位现在处于区间的什么位置)。
  // 时段/盘外价字段保证首屏(SSE quotes 首 tick 前)就能画盘前盘后徽标。
  // 报价容忍度:/api/pool 也是 SSE 断线时的兜底路径(此时推送循环没在暖缓存),
  // 非休市 30s 避免每次请求都打新 FMP 调用;休市价格冻结,与推送循环同一 5 分钟口径
  let enriched = top || [];
  if (enriched.length) {
    try {
      const maxAge = getMarketSession() === 'closed' ? CLOSED_QUOTE_MAX_AGE_MS : 30_000;
      const quotes = await getQuotes([...new Set(enriched.map((c) => c.symbol))], maxAge);
      enriched = enriched.map((c) => {
        const q = quotes.get(c.symbol);
        const price = q ? Number(q.effective_price ?? q.price) : null;
        return {
          ...c,
          current_price: Number.isFinite(price) && price > 0 ? price : null,
          ...quoteDisplayFields(q),
        };
      });
    } catch {
      // 批量报价失败:候选照常返回,前端按缺价降级展示
    }
  }
  return {
    counts: counts || {},
    top: enriched,
    // 系统离场口径(024 起按当前策略):mode='vol' 时 bracket 是每票动态的,
    // 前端按 max_percent 展示"最宽口径"参考;其余策略给出该策略的固定宽度
    // (trailing_only 止盈为 null → 前端展示"无止盈")。legacy 字段始终保留
    reference: (() => {
      const strategy = getTradingStrategy();
      const bracket = strategyBracket(strategy, { volBracketPercent: null, cfg: config });
      return {
        mode: isVolBracketEnabled() ? 'vol' : 'fixed',
        strategy,
        stop_loss_percent: bracket.stopLossPercent,
        take_profit_percent: bracket.takeProfitPercent,
        vol_bracket: {
          k: config.bracketVolK,
          min_percent: config.bracketMinPercent,
          max_percent: config.bracketMaxPercent,
        },
      };
    })(),
  };
}

/** 买入候选池概览(交易记录页):等待资金分配的利好信号;池不可用时 pool 为 null */
router.get(
  '/pool',
  asyncHandler(async (req, res) => {
    res.json({ pool: config.enableMacro ? await getPoolOverview() : null });
  })
);

/**
 * 影子组合 / 消融实验(017):各变体(无风控官/无宏观过滤/信号即时成交/等权/SPY/现金)
 * 的实时估值、净值序列与最近影子成交,外加实盘组合同窗口对照。
 * ?hours=168 限定净值序列窗口;表缺失或未启用返回 available:false。
 */
router.get(
  '/shadow',
  asyncHandler(async (req, res) => {
    if (!config.enableShadow) return res.json({ available: false });
    const hours = Number(req.query.hours);
    const windowHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 366) : 24 * 7;
    const overview = await getShadowOverview({ hours: windowHours });
    if (!overview) return res.json({ available: false });

    // 实盘对照:同窗口净值序列(采样 RPC 优先)+ 当前估值
    const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
    let actualSeries = [];
    const rpc = await supabase().rpc('snapshots_sampled', { since, max_points: 300 });
    if (!rpc.error) {
      actualSeries = (rpc.data || []).map((s) => ({
        t: s.created_at,
        total_value: Number(s.total_value),
      }));
    } else {
      const { data } = await supabase()
        .from('portfolio_snapshots')
        .select('total_value, created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .limit(1000);
      actualSeries = (data || []).map((s) => ({
        t: s.created_at,
        total_value: Number(s.total_value),
      }));
    }
    const valuation = await getValuation().catch(() => null);
    res.json({
      available: true,
      variants: overview.variants,
      series: overview.series,
      recent_trades: overview.recent_trades,
      actual: {
        total_value: valuation?.total_value ?? null,
        cash: valuation?.cash ?? null,
        initial_capital: valuation?.initial_capital ?? null,
        pnl: valuation?.pnl ?? null,
        pnl_percent: valuation?.pnl_percent ?? null,
        positions_count: valuation?.positions?.length ?? null,
        series: actualSeries,
      },
    });
  })
);

/** 单个影子变体的成交流水(消融实验组合展开详情懒加载);未启用返回 available:false */
router.get(
  '/shadow/:variant/trades',
  asyncHandler(async (req, res) => {
    if (!config.enableShadow) return res.json({ available: false });
    const variant = String(req.params.variant || '');
    const limit = Number(req.query.limit);
    const trades = await getShadowTrades({ variant, limit });
    if (trades === null) return res.json({ available: false });
    res.json({ available: true, variant, trades });
  })
);

/**
 * 券商模拟对照账本(021):实盘成交在外部券商模拟账户的真实撮合结果,
 * 逐笔成交价偏差(bps)统计 + 账户净值对照。未配置券商 key 返回 enabled:false,
 * 表缺失(021 未执行)返回 available:false。载荷按约定不含供应商名称。
 */
router.get(
  '/broker-mirror',
  asyncHandler(async (req, res) => {
    res.json(await getBrokerMirrorOverview());
  })
);

/** 单票轻量报价(个股弹窗兜底轮询用):只走报价缓存,不查库、不拉分析/交易历史 */
router.get(
  '/quote/:symbol',
  asyncHandler(async (req, res) => {
    const symbol = String(req.params.symbol || '').toUpperCase();
    if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
      return res.status(400).json({ error: '无效的股票代码' });
    }
    res.json({ quote: await getQuote(symbol).catch(() => null) });
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
        .select('*, news_articles(title, url, published_at, publisher, source)')
        .eq('symbol', symbol)
        .order('created_at', { ascending: false })
        // 热力图按天展示分析分布,50 条只够 ~3 天;放宽到 300 条仍是一次性轻量查询
        .limit(300),
      db
        .from('trades')
        .select('*')
        .eq('symbol', symbol)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);
    // 同一底层事件的近似重复报道聚成一条(先按 event_id,再按标题/事件归纳相似度兜底),
    // 每条带报道数与来源列表,展开见 members
    const analyses = clusterAnalyses(
      analysesRes.data || [],
      config.eventNearDupSimilarity
    ).map(({ representative, members, article_count, sources }) => ({
      ...representative,
      article_count,
      sources,
      members,
    }));
    res.json({
      symbol,
      quote,
      position: posRes.data || null,
      analyses,
      trades: tradesRes.data || [],
    });
  })
);

/**
 * 交易记录(含关联新闻标题与分析)。
 * ?before=<ISO> 游标分页:取该时刻之前的记录——SSE 推送会让列表头部增长,
 * 纯 offset 翻页的偏移会随之漂移漏行,加载更多一律走游标。
 */
router.get(
  '/trades',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    let query = supabase()
      .from('trades')
      .select('*, news_articles(title, url), news_analyses(sentiment, tier, reasoning)')
      .order('created_at', { ascending: false });
    if (before && !Number.isNaN(before.getTime())) {
      query = query.lt('created_at', before.toISOString()).range(0, limit - 1);
    } else {
      query = query.range(offset, offset + limit - 1);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json(data || []);
  })
);

/**
 * 新闻流(含分析结果)。过滤在数据库端完成,前端不再为筛选拉全量数据:
 * ?analyzed=true 只看已分析;?sentiment=bullish|bearish 按方向过滤(隐含已分析且有档位);
 * ?q=xxx 按标题/股票代码搜索;?before=<ISO> 游标分页(发布时间早于该时刻,
 * 防 SSE 推送让 offset 漂移漏行)。
 */
router.get(
  '/news',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const beforeRaw = req.query.before ? new Date(String(req.query.before)) : null;
    const before = beforeRaw && !Number.isNaN(beforeRaw.getTime()) ? beforeRaw : null;
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
        .order('published_at', { ascending: false, nullsFirst: false });
      if (before) {
        query = query.lt('published_at', before.toISOString()).range(0, limit - 1);
      } else {
        query = query.range(offset, offset + limit - 1);
      }
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
