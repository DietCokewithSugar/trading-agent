import { config } from '../config.js';

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/** 基准半点差(基点):市值越小点差越宽;未知市值按小盘从严处理 */
function baseHalfSpreadBps(marketCap) {
  const cap = Number(marketCap);
  if (!Number.isFinite(cap) || cap <= 0) return 30;
  if (cap >= 200e9) return 1; // 超大盘(≥2000 亿)
  if (cap >= 10e9) return 2; // 大盘(≥100 亿)
  if (cap >= 2e9) return 5; // 中盘(≥20 亿)
  if (cap >= 300e6) return 15; // 小盘(≥3 亿)
  return 30; // 微盘
}

/** 时段乘数:盘前盘后流动性差、点差显著放宽;closed 用最近的 stale 价,从严 */
const SESSION_MULT = { regular: 1, pre: 3, post: 3, closed: 4 };

/**
 * 模拟成交价:在市场参考价上施加不利方向的滑点(买入更贵、卖出更便宜)。
 * 滑点 = 半点差(按市值)× 时段乘数 × 波动乘数 + 订单冲击 + 佣金,封顶 slippageMaxBps。
 * 新闻驱动策略的真实瓶颈正是执行成本:消息后买在 spike、盘前盘后点差大、
 * 小盘股流动性差,不建模会系统性高估收益。
 *
 * @param {object} p
 * @param {'buy'|'sell'} p.side
 * @param {object} p.quote   getQuote 返回的报价(effective_price/session/volume/changePercentage)
 * @param {object|null} p.profile 公司档案(marketCap/averageVolume),可为 null
 * @param {number} p.notional 订单金额(美元),用于冲击成本
 * @returns {{ fillPrice: number, slippageBps: number, refPrice: number }}
 */
export function computeFill({ side, quote, profile, notional }) {
  const refPrice = quote.effective_price ?? quote.price;
  if (!config.enableSlippage) {
    return { fillPrice: round4(refPrice), slippageBps: 0, refPrice };
  }

  const half = baseHalfSpreadBps(profile?.marketCap ?? quote.marketCap);
  const sessionMult = SESSION_MULT[quote.session] ?? SESSION_MULT.closed;

  // 当日波动越大点差越宽:涨跌 10% 时点差翻倍,上限 3 倍
  const changePct = Math.abs(Number(quote.changesPercentage ?? quote.changePercentage) || 0);
  const volMult = Math.min(1 + changePct / 10, 3);

  // 订单冲击:按订单金额占日均美元成交额的比例线性近似(占 1% 约 10bp)
  const avgShares = Number(profile?.averageVolume ?? quote.avgVolume ?? quote.volume) || 0;
  const dollarVolume = avgShares * refPrice;
  const impactBps =
    dollarVolume > 0 && Number(notional) > 0 ? (notional / dollarVolume) * 10000 * 0.1 : 0;

  const totalBps = Math.min(
    half * sessionMult * volMult + impactBps + config.commissionBps,
    config.slippageMaxBps
  );

  const direction = side === 'buy' ? 1 : -1;
  const fillPrice = round4(refPrice * (1 + (direction * totalBps) / 10000));
  return { fillPrice, slippageBps: Math.round(totalBps * 100) / 100, refPrice };
}

/**
 * 候选池排队成本(纯函数):入池价 → 成交价的漂移(百分比,正=买贵了)与等待分钟数。
 * 新闻 alpha 衰减很快,排队换"更优资金分配"是否划算必须可度量——这两个指标
 * 落到 trades.pool_*,评估层(signal-stats)按等待时长分桶对比前瞻收益捕获。
 * 入池价/时间缺失或非法时对应字段为 null(016 之前的存量候选)。
 */
export function computePoolMetrics({ entryPrice, enteredAt, fillPrice, now = Date.now() } = {}) {
  const entry = Number(entryPrice);
  const fill = Number(fillPrice);
  const enteredTs = enteredAt ? new Date(enteredAt).getTime() : NaN;
  const nowTs = now instanceof Date ? now.getTime() : Number(now);
  const validEntry = Number.isFinite(entry) && entry > 0;
  return {
    entryPrice: validEntry ? round4(entry) : null,
    waitMinutes:
      Number.isFinite(enteredTs) && Number.isFinite(nowTs)
        ? Math.max(Math.round((nowTs - enteredTs) / 60_000), 0)
        : null,
    driftPercent:
      validEntry && Number.isFinite(fill) ? Math.round((fill / entry - 1) * 10000) / 100 : null,
  };
}
