import { Router } from 'express';
import { supabase } from '../db.js';
import { config } from '../config.js';
import { getValuation } from '../services/portfolio.js';
import { runCycle, cycleStatus } from '../services/newsService.js';
import { sseHandler, clientCount } from '../services/bus.js';

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

/** 净值快照序列(盈亏折线图数据),自动降采样避免点位过多 */
router.get(
  '/snapshots',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 3000, 10000);
    const maxPoints = 600;
    const { data, error } = await supabase()
      .from('portfolio_snapshots')
      .select('total_value, cash, positions_value, pnl, pnl_percent, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);

    const rows = (data || []).reverse();
    if (rows.length <= maxPoints) return res.json(rows);
    // 均匀抽样,保留首尾点
    const step = (rows.length - 1) / (maxPoints - 1);
    const sampled = [];
    for (let i = 0; i < maxPoints; i++) {
      sampled.push(rows[Math.round(i * step)]);
    }
    res.json(sampled);
  })
);

/** 交易记录(含关联新闻标题与分析) */
router.get(
  '/trades',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const { data, error } = await supabase()
      .from('trades')
      .select('*, news_articles(title, url), news_analyses(sentiment, tier, reasoning)')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    res.json(data || []);
  })
);

/** 新闻流(含 DeepSeek 分析结果) */
router.get(
  '/news',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const onlyAnalyzed = req.query.analyzed === 'true';
    let query = supabase()
      .from('news_articles')
      .select('id, url, title, source, publisher, symbols, published_at, fetched_at, news_analyses(*)')
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(limit);
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
    sseClients: clientCount(),
    model: config.deepseekModel,
  });
});

/** 手动触发一轮抓取/分析/交易(设置了 ADMIN_TOKEN 时需要鉴权) */
router.post(
  '/run-cycle',
  asyncHandler(async (req, res) => {
    if (config.adminToken && req.headers['x-admin-token'] !== config.adminToken) {
      return res.status(403).json({ error: '需要有效的 x-admin-token' });
    }
    if (cycleStatus.running) {
      return res.status(409).json({ error: '当前已有一轮在运行中' });
    }
    runCycle({ fullFetch: true }); // 异步执行,不阻塞响应
    res.json({ started: true });
  })
);

export default router;
