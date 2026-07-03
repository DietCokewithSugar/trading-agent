import { Router } from 'express';
import { supabase } from '../db.js';
import { config } from '../config.js';
import { runCycle, cycleStatus, countAnalysisBacklog } from '../services/newsService.js';
import { resetAllData } from '../services/adminService.js';
import { clientCount } from '../services/bus.js';
import { isHalted } from '../services/halt.js';
import { safeTokenEqual, createAuthRateLimiter } from '../services/authGuard.js';
import { getTodayMetrics } from '../services/metrics.js';
import { listRecentRuns, aggregateRejectReasons, isCycleRunsAvailable } from '../services/cycleRuns.js';
import { isTradingHalted, setTradingHalt } from '../services/tradingHalt.js';
import { isVolBracketEnabled, setVolBracketEnabled } from '../services/volBracket.js';
import { getRiskControlState } from '../services/riskControls.js';
import { listRecentDecisions } from '../services/decisionLog.js';
import { getParameterAdvice } from '../services/parameterAdvisor.js';

const router = Router();

function asyncHandler(fn) {
  return (req, res) => {
    fn(req, res).catch((err) => {
      const status = err.status || 500;
      if (status >= 500) console.error(`[admin] ${req.path} 错误: ${err.message}`);
      res.status(status).json({ error: err.message });
    });
  };
}

// 失败限流在鉴权之前:防止 token 被在线暴力破解
router.use(createAuthRateLimiter('admin'));

// 管理接口一律要求鉴权:未配置 ADMIN_TOKEN 时整组接口不可用(拒绝裸奔的危险操作)
router.use((req, res, next) => {
  if (!config.adminToken) {
    return res.status(503).json({ error: '服务端未配置 ADMIN_TOKEN,管理功能不可用' });
  }
  if (!safeTokenEqual(req.headers['x-admin-token'], config.adminToken)) {
    console.warn(`[admin] x-admin-token 校验失败 ip=${req.ip} path=${req.path}`);
    return res.status(403).json({ error: '需要有效的 x-admin-token' });
  }
  next();
});

/** 校验 token 是否有效(前端管理页登录用) */
router.get('/verify', (req, res) => {
  res.json({ ok: true });
});

/** 调度与运行状态(供管理页展示) */
router.get('/status', (req, res) => {
  res.json({
    ...cycleStatus,
    halted: isHalted(),
    tradingHalted: isTradingHalted(),
    volBracketEnabled: isVolBracketEnabled(),
    riskControls: getRiskControlState(),
    sseClients: clientCount(),
    pollSeconds: config.newsPollSeconds,
    riskCheckSeconds: config.riskCheckSeconds,
    model: config.deepseekModel,
    initialCapital: config.initialCapital,
  });
});

/** 交易暂停开关(kill switch):只停新开买入,卖出/止损/止盈/复查不受影响 */
router.post(
  '/trading-halt',
  asyncHandler(async (req, res) => {
    if (typeof req.body?.halted !== 'boolean') {
      return res.status(400).json({ error: '请求体需携带 {"halted": true|false}' });
    }
    const result = await setTradingHalt(req.body.halted);
    console.log(
      `[admin] 交易暂停开关 → ${result.halted ? '开启' : '关闭'}${result.persisted ? '' : '(未持久化,请执行 013 迁移)'}`
    );
    res.json(result);
  })
);

/**
 * 波动自适应敞口运行时开关(023):开启后买入 bracket = clamp(k × 20日波动, min%, max%);
 * 关闭(默认)沿用固定 ±2%。持久化在 portfolio_state,缺列(未执行 023 迁移)开启时报 409
 */
router.post(
  '/vol-bracket',
  asyncHandler(async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: '请求体需携带 {"enabled": true|false}' });
    }
    const result = await setVolBracketEnabled(req.body.enabled);
    console.log(
      `[admin] 波动自适应敞口 → ${result.enabled ? '开启' : '关闭'}${result.persisted ? '' : '(未持久化)'}`
    );
    res.json(result);
  })
);

/** 手动触发一轮全源抓取/分析/交易 */
router.post(
  '/run-cycle',
  asyncHandler(async (req, res) => {
    if (cycleStatus.running) {
      return res.status(409).json({ error: '当前已有一轮在运行中' });
    }
    if (isHalted()) {
      return res.status(409).json({ error: '系统暂停中(可能正在重置数据),请稍后再试' });
    }
    runCycle({ fullFetch: true, trigger: 'admin' }); // 异步执行,不阻塞响应
    res.json({ started: true });
  })
);

/** 待开盘挂单数(指标面板用),表/连接不可用时返回 null */
async function countPendingOrders() {
  try {
    const { count, error } = await supabase()
      .from('pending_orders')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

/**
 * 运行指标(管理页指标面板):最近运行记录、今日 LLM 用量/成本、
 * 上游错误计数、分析积压、待开盘挂单、拒绝原因分布。
 * cycle_runs 的 errors 含上游供应商名称,只允许经本 token 门控接口暴露。
 */
router.get(
  '/metrics',
  asyncHandler(async (req, res) => {
    const [runs, backlog, pendingOrders] = await Promise.all([
      listRecentRuns(20),
      countAnalysisBacklog(),
      countPendingOrders(),
    ]);
    res.json({
      runs,
      runsAvailable: isCycleRunsAvailable(),
      today: getTodayMetrics(),
      backlog,
      pendingOrders,
      rejectReasons: aggregateRejectReasons(runs),
    });
  })
);

/**
 * 参数建议器:把近 N 天的信号统计(机会成本/来源/档位/置信度校准)与影子组合
 * 对照反向映射成参数调整建议——每条建议带样本量与置信区间证据,小样本不出建议。
 * ?days=30 限定统计窗口;011 未迁移(无前瞻收益数据)时返回 available:false。
 */
router.get(
  '/advisor',
  asyncHandler(async (req, res) => {
    const days = Number(req.query.days);
    res.json(
      await getParameterAdvice({
        days: Number.isFinite(days) && days > 0 ? Math.min(days, 180) : 30,
      })
    );
  })
);

/**
 * LLM 交易决策回放记录(018):每次交易员决策连同风控官审批的完整记录。
 * 默认不带大字段(完整 prompt/原始返回),?full=1 时包含——完整 prompt 含
 * 组合明细等内部信息,因此本接口只在 token 门控的管理面提供。
 * 表缺失(未执行 018 迁移)时返回 available:false。
 */
router.get(
  '/decisions',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const full = req.query.full === '1' || req.query.full === 'true';
    const decisions = await listRecentDecisions({ limit, full });
    res.json({ available: decisions !== null, decisions: decisions || [] });
  })
);

/**
 * 全量数据初始化:清空新闻/分析/事件/交易/持仓/快照,现金恢复为初始资金。
 * 不可恢复,要求 body 携带 { "confirm": "RESET" } 二次确认。
 */
router.post(
  '/reset',
  asyncHandler(async (req, res) => {
    if (req.body?.confirm !== 'RESET') {
      return res.status(400).json({ error: '请在请求体中携带 {"confirm":"RESET"} 以确认重置' });
    }
    const result = await resetAllData();
    res.json(result);
  })
);

export default router;
