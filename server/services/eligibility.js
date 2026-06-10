import { config } from '../config.js';

/**
 * 标的准入门槛(只约束买入,卖出/止损永远放行——必须能退出已有持仓):
 * 最小市值、最低股价、最低日均美元成交额(日均成交量 × 现价)。
 * FMP 全市场新闻流会带出大量微盘股,其中不少利好是付费拉抬;
 * 数据缺失按不通过处理(fail-closed:宁可错过,不碰来历不明的票)。
 * 各门槛配置为 0 时关闭对应检查。
 */
export function checkBuyEligibility({ profile, price }) {
  const p = Number(price);

  if (config.minPrice > 0 && !(Number.isFinite(p) && p >= config.minPrice)) {
    return { ok: false, reason: `股价 $${price} 低于准入下限 $${config.minPrice}` };
  }

  if (config.minMarketCap > 0) {
    const cap = Number(profile?.marketCap);
    if (!(Number.isFinite(cap) && cap >= config.minMarketCap)) {
      return {
        ok: false,
        reason: `市值 ${Number.isFinite(cap) ? `$${Math.round(cap / 1e6)}M` : '未知'} 低于准入下限 $${Math.round(config.minMarketCap / 1e6)}M`,
      };
    }
  }

  if (config.minAvgDollarVolume > 0) {
    const avgShares = Number(profile?.averageVolume);
    const dollarVolume = avgShares * p;
    if (!(Number.isFinite(dollarVolume) && dollarVolume >= config.minAvgDollarVolume)) {
      return {
        ok: false,
        reason: `日均美元成交额 ${Number.isFinite(dollarVolume) ? `$${Math.round(dollarVolume / 1e6)}M` : '未知'} 低于准入下限 $${Math.round(config.minAvgDollarVolume / 1e6)}M`,
      };
    }
  }

  return { ok: true, reason: '' };
}
