import { config } from '../config.js';

// 交易所短代码归一:FMP 对 AMEX 的表述不完全统一(AMEX / ASE / NYSE American / NYSE MKT 都出现过)
const EXCHANGE_ALIASES = {
  'NYSE AMERICAN': 'AMEX',
  'NYSE MKT': 'AMEX',
  ASE: 'AMEX',
};

/** 交易所代码归一(大写 trim + 别名映射),无效输入返回 null */
export function normalizeExchange(raw) {
  const x = String(raw ?? '').trim().toUpperCase();
  if (!x) return null;
  return EXCHANGE_ALIASES[x] || x;
}

/**
 * 标的准入门槛(只约束买入,卖出/止损永远放行——必须能退出已有持仓):
 * 交易所白名单、ETF/基金过滤、最小市值、最低股价、最低日均美元成交额(日均成交量 × 现价)。
 * FMP 全市场新闻流会带出大量微盘股,其中不少利好是付费拉抬;
 * 数据缺失按不通过处理(fail-closed:宁可错过,不碰来历不明的票)。
 * 各门槛配置为 0 / 白名单配置为空时关闭对应检查。
 * 确定性硬规则先行,LLM 的标的核验(decideTrade#symbol_valid)是第二层。
 */
export function checkBuyEligibility({ profile, price }) {
  const p = Number(price);

  // 交易所白名单(fail-closed):默认 NASDAQ/NYSE/AMEX,天然屏蔽 OTC/PNK 粉单。
  // 匹配短代码而非 exchangeFullName(全名表述多变,短代码 + 小别名表更稳健)。
  // 主板上市的 ADR(BABA/TSM 等)是合法标的,白名单天然放行,不额外拦截
  if (config.allowedExchanges.length > 0) {
    const exchange = normalizeExchange(profile?.exchange ?? profile?.exchangeShortName);
    if (!exchange || !config.allowedExchanges.includes(exchange)) {
      return {
        ok: false,
        reason: `交易所 ${exchange ?? '未知'} 不在准入白名单(${config.allowedExchanges.join('/')})`,
      };
    }
  }

  // ETF/基金过滤:公司新闻管线不交易 ETF/基金(指数/行业新闻与个股新闻语义不同)。
  // 与其他检查的 fail-closed 不对称:正常个股缺 isEtf/isFund 字段很常见(旧缓存/旧接口),
  // 按缺失拒绝会误杀大量正常股票;而市值缺失本身就可疑。故仅在显式 === true 时拒绝
  if (profile?.isEtf === true || profile?.isFund === true) {
    return { ok: false, reason: '标的为 ETF/基金,公司新闻管线不交易' };
  }

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
