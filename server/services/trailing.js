// 移动止损棘轮纯函数(无 IO、无副作用,便于单测,沿 sizing.js / holding.js 先例)。
// 从 riskMonitor.js#maybeTrailStop 抽取:实盘与 trailing_only 影子变体共用同一套语义,
// 两边只保留各自的 DB 读写与降级逻辑。

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * 计算棘轮上抬后的止损价:股价创出建仓后新高时,按"峰值价 × (1 - 原止损距离)"上抬。
 * 止损只升不降;新止损至少高出现值 minRaiseRatio(默认 0.5%)才建议落库,避免高频写。
 * base = peakPrice ?? avgCost(峰值缺失时以成本价为锚,007 语义)。
 * 返回 null(不动)或 { stop, peak }(建议写入的新止损价与新峰值)。
 */
export function computeTrailedStop({ price, stop, peakPrice = null, avgCost, minRaiseRatio = 1.005 } = {}) {
  const stopNum = Number(stop);
  const priceNum = Number(price);
  if (!(stopNum > 0) || !(priceNum > 0)) return null;

  const base =
    peakPrice !== null && peakPrice !== undefined ? Number(peakPrice) : Number(avgCost);
  if (!(base > 0) || priceNum <= base) return null;

  // 止损距离:由当前基准价与止损价反推,首次即买入时设定的百分比,之后保持不变
  const distance = (base - stopNum) / base;
  if (distance <= 0 || distance >= 1) return null;

  const newStop = round4(priceNum * (1 - distance));
  if (newStop < stopNum * minRaiseRatio) return null;

  return { stop: newStop, peak: round4(priceNum) };
}
