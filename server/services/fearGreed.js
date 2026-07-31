/**
 * 恐惧贪婪情绪指数(估值看板 033 的外部数据源,CNN Fear & Greed 公开 JSON)。
 * 观察层 fail-open:抓取失败先回退 48h 内的旧值,超龄返回 null(卡片显示「暂无数据」),
 * 绝不抛错、绝不影响其他数据源;公开载荷/UI 不出现供应商名(约定见 CLAUDE.md)。
 */
import { config } from '../config.js';

// 免密钥公开接口按浏览器口径声明 UA(默认 UA 会被 CDN 拦截)
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15_000;
const FRESH_MS = 6 * 3600_000; // 缓存新鲜期:6 小时内不重复抓取(看板本身日频)
const STALE_MAX_MS = 48 * 3600_000; // 失败回退旧值的最长可用期
const WARN_INTERVAL_MS = 30 * 60_000;

const state = {
  data: null, // { score, fetched_at }
  fetchedAt: 0,
  inflight: null,
  lastWarnAt: 0,
};

function warnLimited(msg) {
  if (Date.now() - state.lastWarnAt < WARN_INTERVAL_MS) return;
  state.lastWarnAt = Date.now();
  console.warn(`[valuation] 情绪指数抓取失败(卡片按旧值/暂无数据降级): ${msg}`);
}

async function fetchOnce() {
  const res = await fetch(config.fearGreedUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`情绪源响应 ${res.status}`);
  const body = await res.json();
  // 解析口径:{ fear_and_greed: { score } };score ∈ [0,100]
  const score = Number(body?.fear_and_greed?.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error('情绪源返回结构不符');
  }
  return { score: Math.round(score * 10) / 10, fetched_at: new Date().toISOString() };
}

/**
 * 当前情绪指数:{ score, fetched_at } | null。
 * 新鲜缓存直接返回;过期则抓取(并发共享同一 in-flight),失败回退未超龄旧值。
 */
export async function getFearGreed() {
  const age = Date.now() - state.fetchedAt;
  if (state.data && age < FRESH_MS) return state.data;
  if (!state.inflight) {
    state.inflight = fetchOnce()
      .then((data) => {
        state.data = data;
        state.fetchedAt = Date.now();
        return data;
      })
      .catch((err) => {
        warnLimited(err.message);
        return null;
      })
      .finally(() => {
        state.inflight = null;
      });
  }
  const fresh = await state.inflight;
  if (fresh) return fresh;
  // 失败回退:旧值未超龄仍可用(fetched_at 保留原时间,前端可见数据实际时点)
  if (state.data && Date.now() - state.fetchedAt < STALE_MAX_MS) return state.data;
  return null;
}

/** 测试/重置用:清空进程内缓存 */
export function clearFearGreedCache() {
  state.data = null;
  state.fetchedAt = 0;
  state.inflight = null;
  state.lastWarnAt = 0;
}
