// 确定性市场环境核验:SPY 相对 20 日均线的趋势 + VIX 水平,推出一个与新闻无关的
// regime,与新闻推导的 regime 取交集——只有两者同向 risk_on 时才放行仓位放大,
// 减少对 LLM 读标题的单一依赖,成本几乎为零(每轮两个报价 + 一次缓存日线)。
// 方向性约定:核验只钳制放大、从不放松——risk_off/macro_shock 原样通过。
// fail-open:VIX 不可用(套餐不含指数)退化为仅 SPY 趋势;SPY 数据不可用则核验
// 整体停用(available=false,交集透传),绝不影响交易主链路。
// 纯函数(sma / classifyMarketTrend / intersectRegime)与抓取薄层分离,前者可单测。
import { config } from '../config.js';
import { getQuote, getHistoricalPricesAdjusted } from './fmp.js';

/** 简单移动平均:取末尾 n 个值;样本不足返回 null */
export function sma(values, n) {
  const nums = (Array.isArray(values) ? values : []).map(Number).filter((v) => Number.isFinite(v));
  if (!Number.isFinite(n) || n <= 0 || nums.length < n) return null;
  const tail = nums.slice(-n);
  return tail.reduce((a, b) => a + b, 0) / n;
}

/**
 * 确定性市场趋势分类(纯函数):
 *  - risk_off:SPY 跌破均线缓冲带下沿,或 VIX ≥ vixRiskOffMin(恐慌定价);
 *  - risk_on:SPY 站上缓冲带上沿,且 VIX 缺失或 < vixRiskOnMax;
 *  - 其余为 neutral。缓冲带(±smaBufferPercent%)避免贴着均线来回翻转。
 * 输入不足(价格/均线缺失)返回 null,调用方按核验不可用处理。
 */
export function classifyMarketTrend({ spyPrice, sma20, vix = null, cfg = {} } = {}) {
  const {
    smaBufferPercent = 0.5,
    vixRiskOnMax = 20,
    vixRiskOffMin = 26,
  } = cfg;
  const price = Number(spyPrice);
  const avg = Number(sma20);
  if (!(price > 0) || !(avg > 0)) return null;
  const vixNum = Number.isFinite(Number(vix)) && Number(vix) > 0 ? Number(vix) : null;
  if (price < avg * (1 - smaBufferPercent / 100) || (vixNum !== null && vixNum >= vixRiskOffMin)) {
    return 'risk_off';
  }
  if (price >= avg * (1 + smaBufferPercent / 100) && (vixNum === null || vixNum < vixRiskOnMax)) {
    return 'risk_on';
  }
  return 'neutral';
}

/**
 * 新闻 regime 与确定性核验取交集(纯函数):
 * 仅当新闻 regime 为 risk_on 且核验可用但不同向时,降级按 neutral 参数执行;
 * 其余(neutral/risk_off/macro_shock、核验不可用)原样透传——避险方向永不放松。
 * 返回 { regime, clamped }。
 */
export function intersectRegime(newsRegime, marketCheck) {
  if (newsRegime !== 'risk_on') return { regime: newsRegime, clamped: false };
  if (!marketCheck?.available || !marketCheck.trend) return { regime: newsRegime, clamped: false };
  if (marketCheck.trend === 'risk_on') return { regime: newsRegime, clamped: false };
  return { regime: 'neutral', clamped: true };
}

// ── 抓取薄层(进程内缓存,调度器周期刷新)──

const state = {
  available: false, // SPY 趋势就绪才为 true;false 时交集透传(fail-open)
  trend: null, // 'risk_on' | 'neutral' | 'risk_off'
  spyPrice: null,
  sma20: null,
  vix: null,
  vixUnavailable: false, // 套餐不含指数报价(403/404),一次告警后永久 SPY-only
  fetchedAt: null,
};

function isPlanError(err) {
  return /请求失败 40[34]\b/.test(err?.message || '');
}

const TREND_LABELS = { risk_on: '风险偏好', neutral: '中性', risk_off: '避险' };

/** 刷新核验状态,由调度器周期调用;任何失败只停用核验本身,绝不抛出 */
export async function refreshMarketCheck() {
  if (!config.enableMacro || !config.enableMarketCheck || !config.fmpApiKey) return;
  try {
    const params = config.marketCheckParams;
    const fmt = (d) => d.toISOString().slice(0, 10);
    const now = Date.now();
    // 60 天窗口给 20 个交易日留足周末/假日余量
    const { rows } = await getHistoricalPricesAdjusted(
      'SPY',
      fmt(new Date(now - 60 * 24 * 3600_000)),
      fmt(new Date(now))
    );
    const sma20 = sma((rows || []).map((r) => r.price), params.smaDays);
    const quote = await getQuote('SPY');
    const spyPrice = Number(quote?.effective_price ?? quote?.price);
    if (!(sma20 > 0) || !(spyPrice > 0)) throw new Error('SPY 价格/均线数据不足');

    let vix = state.vix;
    if (!state.vixUnavailable) {
      try {
        const vq = await getQuote('^VIX');
        vix = Number(vq?.price) > 0 ? Number(vq.price) : null;
      } catch (err) {
        if (isPlanError(err)) {
          state.vixUnavailable = true;
          vix = null;
          console.warn('[market] 当前数据套餐不含 VIX 指数报价,核验退化为仅 SPY 趋势');
        } else {
          vix = null; // 瞬时失败:本轮仅按 SPY 判定,下轮重试
          console.warn(`[market] VIX 报价获取失败(本轮仅按 SPY 趋势): ${err.message}`);
        }
      }
    }

    const trend = classifyMarketTrend({ spyPrice, sma20, vix, cfg: params });
    const switched = state.available && state.trend !== trend;
    state.available = true;
    state.trend = trend;
    state.spyPrice = Math.round(spyPrice * 100) / 100;
    state.sma20 = Math.round(sma20 * 100) / 100;
    state.vix = vix;
    state.fetchedAt = new Date().toISOString();
    if (switched) {
      console.log(
        `[market] 确定性市场趋势切换 → ${TREND_LABELS[trend] || trend}(SPY $${state.spyPrice} vs SMA${params.smaDays} $${state.sma20}${vix !== null ? `,VIX ${vix}` : ''})`
      );
    }
  } catch (err) {
    state.available = false;
    state.trend = null;
    console.warn(`[market] 市场核验刷新失败(核验停用,新闻 regime 不受影响): ${err.message}`);
  }
}

/** 当前核验状态(同步,进程内缓存) */
export function getMarketCheck() {
  return { ...state };
}
