import { Router } from 'express';
import { config } from '../config.js';
import { runCycle, cycleStatus } from '../services/newsService.js';
import { resetAllData } from '../services/adminService.js';
import { clientCount } from '../services/bus.js';
import { isHalted } from '../services/halt.js';
import { safeTokenEqual, createAuthRateLimiter } from '../services/authGuard.js';

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
    sseClients: clientCount(),
    pollSeconds: config.newsPollSeconds,
    riskCheckSeconds: config.riskCheckSeconds,
    model: config.deepseekModel,
    initialCapital: config.initialCapital,
  });
});

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
    runCycle({ fullFetch: true }); // 异步执行,不阻塞响应
    res.json({ started: true });
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
