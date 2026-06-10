import crypto from 'node:crypto';
import { rateLimit } from 'express-rate-limit';

/**
 * 常数时间口令比较:双方先 sha256 定长化再 timingSafeEqual,
 * 既规避逐字符比较的时序泄漏,也规避长度不同导致的异常/泄漏。
 */
export function safeTokenEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * 鉴权失败限流器:同一 IP 在 15 分钟窗口内最多 10 次失败请求
 * (skipSuccessfulRequests:鉴权成功的正常管理操作不计数),
 * 防止 x-admin-token 被在线暴力破解。挂在鉴权中间件之前。
 */
export function createAuthRateLimiter(logPrefix = 'admin') {
  return rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      console.warn(`[${logPrefix}] 鉴权失败次数过多,已限流 ip=${req.ip} path=${req.path}`);
      res.status(429).json({ error: '尝试过于频繁,请 15 分钟后再试' });
    },
  });
}
