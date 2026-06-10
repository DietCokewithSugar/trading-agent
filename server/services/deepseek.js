import { config } from '../config.js';

/**
 * 调用 DeepSeek Chat Completions(OpenAI 兼容),强制返回 JSON。
 * 文档: https://api-docs.deepseek.com/
 */
async function chatJSON(messages, { temperature = 0.2, maxTokens = 1200 } = {}) {
  const res = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: config.deepseekModel,
      messages,
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DeepSeek 请求失败 ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 返回内容为空');
  return JSON.parse(content);
}

/**
 * 档位规则:
 *  第一档 = 影响程度大 + 影响范围大
 *  第二档 = 影响程度大 + 影响范围小
 *  第三档 = 影响程度小 + 影响范围大
 *  第四档 = 影响程度小 + 影响范围小
 */
export function computeTier(impactStrength, impactScope) {
  const strong = impactStrength === 'high';
  const wide = impactScope === 'wide';
  if (strong && wide) return 1;
  if (strong && !wide) return 2;
  if (!strong && wide) return 3;
  return 4;
}

const ANALYST_SYSTEM_PROMPT = `你是一名资深美股新闻分析师。你的任务是判断一条新闻对某家美股上市公司是利好(bullish)还是利空(bearish),并评估:
- 影响程度(impact_strength):high=对该公司股价的影响程度大,low=影响程度小
- 影响范围(impact_scope):wide=影响范围大(波及整个行业/市场/公司核心业务),narrow=影响范围小(仅涉及局部业务/单一事件)

必须严格返回如下 JSON(不要输出其他内容):
{
  "relevant": true 或 false,          // 该新闻是否与某家美股上市公司明确相关且可交易
  "symbol": "AAPL",                   // 受影响最直接的美股代码(大写),不相关时为 null
  "company_name": "Apple Inc.",
  "sentiment": "bullish" | "bearish" | "neutral",
  "impact_strength": "high" | "low",
  "impact_scope": "wide" | "narrow",
  "confidence": 0.0 到 1.0 之间的数字,  // 你对该判断的置信度
  "reasoning": "用中文简明扼要地说明判断理由(100字以内)"
}

注意:只针对美国交易所上市的股票(含 ADR)。如果新闻是宏观、加密货币、或无法对应具体美股公司,relevant 设为 false。`;

/** 用 DeepSeek 分析一条新闻的利好/利空与档位 */
export async function analyzeArticle(article) {
  const user = [
    `新闻标题: ${article.title}`,
    article.symbols?.length ? `相关股票代码: ${article.symbols.join(', ')}` : '',
    `来源: ${article.publisher || article.source || '未知'}`,
    `发布时间: ${article.published_at || '未知'}`,
    `正文: ${(article.text_content || '').slice(0, 3000)}`,
  ]
    .filter(Boolean)
    .join('\n');

  const result = await chatJSON([
    { role: 'system', content: ANALYST_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]);

  if (!result.relevant || !result.symbol || result.sentiment === 'neutral') {
    return { ...result, tier: null };
  }
  return {
    ...result,
    symbol: String(result.symbol).toUpperCase(),
    tier: computeTier(result.impact_strength, result.impact_scope),
  };
}

const TRADER_SYSTEM_PROMPT = `你是一个谨慎的美股模拟交易决策引擎。根据一条新闻的利好/利空分析和当前组合状态,决定是否交易。

规则:
- 只能做多,不能做空;只能卖出当前已持有的股票。
- buy 时 fraction 表示动用可用现金的比例(0~1);sell 时 fraction 表示卖出该股票持仓的比例(0~1)。
- 利好且档位高(第1、2档)可考虑买入;利空且已持有该股票可考虑卖出;信号弱或不确定时选择 hold。
- 注意分散风险,单只股票仓位不宜过重。
- buy 时必须同时设定止损与止盈位:stop_loss_percent 表示跌破成本价该百分比时自动止损(3~15 之间),take_profit_percent 表示涨过成本价该百分比时自动止盈(5~30 之间)。新闻影响越强、确定性越高,止盈可设得越远;股票波动性越大,止损应留出越多空间。
- reason 用中文写明本次决策依据(引用新闻要点,80字以内)。

必须严格返回 JSON:
{
  "action": "buy" | "sell" | "hold",
  "fraction": 0.0 到 1.0,
  "stop_loss_percent": 3 到 15 之间的数字,   // 仅 buy 时有意义
  "take_profit_percent": 5 到 30 之间的数字, // 仅 buy 时有意义
  "reason": "中文决策理由"
}`;

/** 用 DeepSeek 基于新闻分析 + 组合状态做交易决策 */
export async function decideTrade({ analysis, article, quote, portfolio }) {
  const position = portfolio.positions.find((p) => p.symbol === analysis.symbol);
  const user = JSON.stringify(
    {
      新闻标题: article.title,
      分析: {
        股票: analysis.symbol,
        方向: analysis.sentiment === 'bullish' ? '利好' : '利空',
        档位: `第${analysis.tier}档`,
        影响程度: analysis.impact_strength === 'high' ? '大' : '小',
        影响范围: analysis.impact_scope === 'wide' ? '大' : '小',
        置信度: analysis.confidence,
        理由: analysis.reasoning,
      },
      实时行情: {
        当前价格: quote.effective_price ?? quote.price,
        市场时段: quote.session ?? 'regular',
        盘前盘后价: quote.extended_price ?? null,
        今日涨跌幅百分比: quote.changesPercentage ?? quote.changePercentage ?? null,
      },
      组合状态: {
        可用现金: portfolio.cash,
        组合总值: portfolio.totalValue,
        该股票当前持仓: position
          ? { 数量: position.quantity, 平均成本: position.avg_cost }
          : null,
        所有持仓: portfolio.positions.map((p) => ({
          代码: p.symbol,
          数量: p.quantity,
          平均成本: p.avg_cost,
        })),
      },
    },
    null,
    1
  );

  const result = await chatJSON([
    { role: 'system', content: TRADER_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]);

  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  };

  const action = ['buy', 'sell', 'hold'].includes(result.action) ? result.action : 'hold';
  return {
    action,
    fraction: clamp(result.fraction, 0, 1, 0),
    stopLossPercent: clamp(result.stop_loss_percent, 3, 15, 8),
    takeProfitPercent: clamp(result.take_profit_percent, 5, 30, 15),
    reason: result.reason || '',
  };
}
