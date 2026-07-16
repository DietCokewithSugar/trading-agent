/**
 * 回测经典基线策略(032,纯函数):bars → targets[](与 bars 等长,1=满仓,0=空仓)。
 * 全部多头-only(与实盘账本约束一致);targets[i] 是"第 i 根收盘时决定的目标仓位",
 * 由引擎在第 i+1 根收盘执行(严格因果,见 engine.js#runTargetStrategy)。
 * 指标为 null(暖机期)时保持既有仓位不动;初始状态空仓。
 * 各策略参数论文未给出精确定义,取业界常用口径,默认值在 config.backtestParams。
 */

import { macd, rsi, kdj, zscore, sma } from './indicators.js';

/** 买入持有:恒 1(引擎在首根可执行 K 线收盘全仓买入,持有到窗口结束) */
export function buyHoldTargets(bars) {
  return bars.map(() => 1);
}

/** MACD:hist(DIF−DEA)> 0 持仓,< 0 空仓,= 0 或暖机期保持 */
export function macdTargets(bars, params = {}) {
  const { hist } = macd(bars.map((b) => b.close), params);
  let state = 0;
  return bars.map((_, i) => {
    if (hist[i] !== null) {
      if (hist[i] > 0) state = 1;
      else if (hist[i] < 0) state = 0;
    }
    return state;
  });
}

/**
 * KDJ+RSI 组合(超卖进/超买出,或逻辑):
 * 进场:J ≤ kdj.oversold 或 RSI ≤ rsi.oversold;离场:J ≥ kdj.overbought 或 RSI ≥ rsi.overbought;
 * 其余保持。单边指标暖机期内以另一边为准。
 */
export function kdjRsiTargets(bars, { kdj: kdjParams = {}, rsi: rsiParams = {} } = {}) {
  const { J } = kdj(bars, kdjParams);
  const rsiValues = rsi(bars.map((b) => b.close), rsiParams.period ?? 14);
  const jOversold = kdjParams.oversold ?? 20;
  const jOverbought = kdjParams.overbought ?? 80;
  const rOversold = rsiParams.oversold ?? 30;
  const rOverbought = rsiParams.overbought ?? 70;
  let state = 0;
  return bars.map((_, i) => {
    const enter =
      (J[i] !== null && J[i] <= jOversold) || (rsiValues[i] !== null && rsiValues[i] <= rOversold);
    const exit =
      (J[i] !== null && J[i] >= jOverbought) ||
      (rsiValues[i] !== null && rsiValues[i] >= rOverbought);
    // 同时满足进出(极端震荡)按离场处理 —— 保守优先,与引擎"先止损后止盈"同精神
    if (exit) state = 0;
    else if (enter) state = 1;
    return state;
  });
}

/** ZMR 零均值回归:z-score ≤ entryZ(显著低于均值)进场,回归到 ≥ exitZ 离场,其余保持 */
export function zmrTargets(bars, { period = 20, entryZ = -1, exitZ = 0 } = {}) {
  const z = zscore(bars.map((b) => b.close), period);
  let state = 0;
  return bars.map((_, i) => {
    if (z[i] !== null) {
      if (state === 0 && z[i] <= entryZ) state = 1;
      else if (state === 1 && z[i] >= exitZ) state = 0;
    }
    return state;
  });
}

/** SMA 双均线:快线 > 慢线持仓,快线 < 慢线空仓,相等或暖机期保持 */
export function smaTargets(bars, { fast = 10, slow = 30 } = {}) {
  const closes = bars.map((b) => b.close);
  const fastLine = sma(closes, fast);
  const slowLine = sma(closes, slow);
  let state = 0;
  return bars.map((_, i) => {
    if (fastLine[i] !== null && slowLine[i] !== null) {
      if (fastLine[i] > slowLine[i]) state = 1;
      else if (fastLine[i] < slowLine[i]) state = 0;
    }
    return state;
  });
}

/** 基线策略注册表:key 与前端标签映射/结果 payload 对齐(ai 单独走 runAiStrategy) */
export const BASELINE_STRATEGIES = {
  buy_hold: (bars) => buyHoldTargets(bars),
  macd: (bars, params) => macdTargets(bars, params.macd),
  kdj_rsi: (bars, params) => kdjRsiTargets(bars, { kdj: params.kdj, rsi: params.rsi }),
  zmr: (bars, params) => zmrTargets(bars, params.zmr),
  sma: (bars, params) => smaTargets(bars, params.sma),
};
