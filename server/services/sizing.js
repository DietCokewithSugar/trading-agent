import { config } from '../config.js';

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * 仓位缩放链的纯计算部分:LLM fraction × 档位乘数 × 置信度乘数 × 来源可信度乘数。
 * 信号档位越低、置信度越低、来源越不可靠,实际动用的资金越少
 * (Lopez-Lira:LLM 信号强度应映射到仓位);风控官 scale 与硬性风控帽在 trader 中叠加。
 *  - 置信度 0.5 → ×0.5,1.0 → ×1;缺失按 ×0.7
 *  - 来源可信度 → ×0.6~×1:通讯社/公告级接近全额,小站/观点文减仓;无评分(旧库)不缩放
 */
export function scaleFraction({ fraction, tier, confidence, sourceScore }) {
  const tierMult = config.tierSizeMultipliers[tier] ?? 0.5;
  const conf =
    confidence === null || confidence === undefined ? null : Number(confidence);
  const confMult = conf === null ? 0.7 : Math.min(Math.max(conf, 0.5), 1);
  const src =
    sourceScore === null || sourceScore === undefined ? null : Number(sourceScore);
  const srcMult = src === null ? 1 : Math.min(Math.max(0.5 + 0.5 * src, 0.6), 1);
  return {
    sized: round4(fraction * tierMult * confMult * srcMult),
    tierMult,
    confMult,
    srcMult,
  };
}
