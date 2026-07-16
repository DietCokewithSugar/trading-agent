/**
 * 回测技术指标(032,纯函数,无 IO)。
 * 所有函数返回与输入等长的数组,暖机期(样本不足)一律为 null;
 * 输入非法(period 无效/序列过短)返回全 null 数组,不抛错 —— 策略层对 null 保持仓位不动。
 */

const round4 = (n) => Math.round(n * 1e4) / 1e4;

/** 简单移动平均:前 period-1 位为 null */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (!Number.isInteger(period) || period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 指数移动平均:以前 period 个值的均值为种子(位于 index period-1),k = 2/(period+1) */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (!Number.isInteger(period) || period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * MACD:macdLine = EMA(fast) − EMA(slow);signalLine = macdLine 的 EMA(signal)
 * (种子 = macdLine 前 signal 个非 null 值的均值);hist = macdLine − signalLine。
 */
export function macd(closes, { fast = 12, slow = 26, signal = 9 } = {}) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
  );
  const signalLine = new Array(closes.length).fill(null);
  const k = 2 / (signal + 1);
  let count = 0;
  let seedSum = 0;
  let prev = null;
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] === null) continue;
    if (prev === null) {
      seedSum += macdLine[i];
      count += 1;
      if (count === signal) {
        prev = seedSum / signal;
        signalLine[i] = prev;
      }
    } else {
      prev = macdLine[i] * k + prev * (1 - k);
      signalLine[i] = prev;
    }
  }
  const hist = closes.map((_, i) =>
    macdLine[i] !== null && signalLine[i] !== null ? macdLine[i] - signalLine[i] : null
  );
  return { macdLine, signalLine, hist };
}

/**
 * RSI(Wilder 平滑):首值位于 index period(用前 period 个涨跌幅的简单均值),
 * 之后 avg = (prevAvg × (period−1) + 当期) / period;全涨(avgLoss=0)→ 100。
 */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (!Number.isInteger(period) || period <= 0 || closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const chg = closes[i] - closes[i - 1];
    if (chg >= 0) gain += chg;
    else loss -= chg;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const toRsi = () => {
    if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  };
  out[period] = toRsi();
  for (let i = period + 1; i < closes.length; i++) {
    const chg = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(chg, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-chg, 0)) / period;
    out[i] = toRsi();
  }
  return out;
}

/**
 * KDJ:RSV = (close − 周期内最低) / (周期内最高 − 最低) × 100(区间为 0 时取 50);
 * K = (k−1)/k × prevK + 1/k × RSV,D 同理对 K 平滑(K/D 种子 50,经典口径),J = 3K − 2D。
 * bars 为 [{ high, low, close }],暖机期(前 period−1 根)为 null。
 */
export function kdj(bars, { period = 9, k = 3, d = 3 } = {}) {
  const n = bars.length;
  const K = new Array(n).fill(null);
  const D = new Array(n).fill(null);
  const J = new Array(n).fill(null);
  if (!Number.isInteger(period) || period <= 0 || k <= 0 || d <= 0) return { K, D, J };
  let prevK = 50;
  let prevD = 50;
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (bars[j].high > hh) hh = bars[j].high;
      if (bars[j].low < ll) ll = bars[j].low;
    }
    const rsv = hh === ll ? 50 : ((bars[i].close - ll) / (hh - ll)) * 100;
    prevK = ((k - 1) / k) * prevK + (1 / k) * rsv;
    prevD = ((d - 1) / d) * prevD + (1 / d) * prevK;
    K[i] = round4(prevK);
    D[i] = round4(prevD);
    J[i] = round4(3 * prevK - 2 * prevD);
  }
  return { K, D, J };
}

/** 滚动 z-score:(close − SMA(period)) / 样本标准差;std 为 0(如价格恒定)时为 null */
export function zscore(closes, period = 20) {
  const out = new Array(closes.length).fill(null);
  if (!Number.isInteger(period) || period <= 1) return out;
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (closes[j] - mean) ** 2;
    const std = Math.sqrt(sq / (period - 1));
    if (Number.isFinite(std) && std > 0) out[i] = (closes[i] - mean) / std;
  }
  return out;
}
