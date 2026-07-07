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
import { getTradingStrategy, setTradingStrategy, STRATEGIES } from '../services/strategy.js';
import { isBrokerLedgerPrimary, setBrokerLedgerPrimary } from '../services/primaryLedger.js';
import { isBrokerEnabled } from '../services/alpacaBroker.js';
import {
  getBrokerAccountsOverview,
  addBrokerAccount,
  updateBrokerAccount,
  deleteBrokerAccount,
} from '../services/brokerAccounts.js';
import { SHADOW_VARIANTS } from '../services/shadowPortfolio.js';
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
    tradingStrategy: getTradingStrategy(),
    brokerLedgerPrimary: isBrokerLedgerPrimary(),
    brokerMirrorAvailable: isBrokerEnabled(),
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
 * 主账户交易策略选择(024,取代 023 的 vol-bracket 布尔开关):预设对应消融实验各变体。
 * 入场路径类(immediate 类与等权)绕过候选池/LLM/风控官(锁内硬风控仍全部生效,
 * 分配器暂停);非法预设 400,缺列(未执行 024 迁移)409
 */
router.post(
  '/strategy',
  asyncHandler(async (req, res) => {
    if (typeof req.body?.strategy !== 'string') {
      return res.status(400).json({ error: `请求体需携带 {"strategy": "..."},可选: ${STRATEGIES.join(' / ')}` });
    }
    const result = await setTradingStrategy(req.body.strategy);
    console.log(`[admin] 交易策略 → ${result.strategy}${result.persisted ? '' : '(未持久化)'}`);
    res.json(result);
  })
);

/**
 * 展示主账本切换(024):开启后仪表盘主视图(净值/持仓/曲线)展示券商模拟账户实时数据;
 * 内部引擎账本与交易链路不变。未配置券商 API / 缺列(未执行 024 迁移)开启时报 409
 */
router.post(
  '/primary-ledger',
  asyncHandler(async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: '请求体需携带 {"enabled": true|false}' });
    }
    const result = await setBrokerLedgerPrimary(req.body.enabled);
    console.log(
      `[admin] 展示主账本 → ${result.enabled ? '券商模拟账户' : '内部账本'}${result.persisted ? '' : '(未持久化)'}`
    );
    res.json(result);
  })
);

// ── 多券商模拟账户(025):添加多个券商模拟账户,按消融变体指派用途 ──
// 密钥只进不出:secret 永不返回,key_id 输出前脱敏;账户表 RLS 无公共读策略。
// 可指派用途 = 影子变体(cash 不交易,排除)
const ACCOUNT_PURPOSES = SHADOW_VARIANTS.filter((v) => v !== 'cash');

/** 账户总览(脱敏)+ 可指派用途清单 */
router.get(
  '/broker-accounts',
  asyncHandler(async (req, res) => {
    const overview = await getBrokerAccountsOverview();
    res.json({ ...overview, purposes: ACCOUNT_PURPOSES });
  })
);

/** 新增账户:{ name, key_id, secret_key, base_url? };先向券商校验连通性,失败 400 不入库 */
router.post(
  '/broker-accounts',
  asyncHandler(async (req, res) => {
    const { name, key_id: keyId, secret_key: secretKey, base_url: baseUrl } = req.body || {};
    const account = await addBrokerAccount({ name, keyId, secretKey, baseUrl: baseUrl || null });
    res.json({ account });
  })
);

/** 更新账户:{ name?, purpose?, enabled? };purpose 须为影子变体名或 null(闲置) */
router.post(
  '/broker-accounts/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '账户 id 非法' });
    const patch = {};
    if (req.body?.name !== undefined) patch.name = req.body.name;
    if (req.body?.enabled !== undefined) patch.enabled = req.body.enabled;
    if (req.body?.purpose !== undefined) {
      const purpose = req.body.purpose || null;
      if (purpose !== null && !ACCOUNT_PURPOSES.includes(purpose)) {
        return res
          .status(400)
          .json({ error: `未知用途 ${purpose},可选: 闲置(null) / ${ACCOUNT_PURPOSES.join(' / ')}` });
      }
      patch.purpose = purpose;
    }
    const account = await updateBrokerAccount(id, patch);
    res.json({ account });
  })
);

/** 删除账户(先 best-effort 撤销券商侧未成交单;执行单/快照级联删除) */
router.delete(
  '/broker-accounts/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '账户 id 非法' });
    res.json(await deleteBrokerAccount(id));
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
