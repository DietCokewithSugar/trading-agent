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
  "reasoning": "用中文简明扼要地说明判断理由(100字以内)",
  "event_summary": "一句话归纳新闻背后的核心事件:主体+事件类型+关键事实(中文,40字以内)"
}

注意:
1. 只针对美国交易所上市、当前可正常交易的股票(含 ADR)。如果新闻是宏观、加密货币、或无法对应具体美股公司,relevant 设为 false。
2. 新闻主体必须是"已经上市"的公司。若主体是未上市的私有公司或仅处于"即将/计划 IPO"阶段(如 SpaceX、OpenAI、Stripe 等),严禁映射到任何名称相似或业务相关的已上市公司代码(典型错误:SpaceX 不是 SPCE,SPCE 是 Virgin Galactic),此时 relevant 必须为 false。
3. event_summary 用于跨媒体的事件归并:同一底层事件被不同媒体以不同标题报道时,你的归纳应当一致(写"发生了什么",不要写媒体的评论角度)。`;

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

const TRADER_SYSTEM_PROMPT = `你是一个谨慎的美股模拟交易决策引擎。根据一条新闻的利好/利空分析、该股票的公司档案与实时行情、当前组合状态,决定是否交易。

第一步,必须先做交易标的核验(symbol_valid):
1. 新闻真正的主体公司,是否就是"公司档案"中的这家公司?若新闻讲的是另一家公司——尤其是名称相似/业务相关的未上市公司(典型错误:把 SpaceX 的新闻当成 SPCE,而 SPCE 是 Virgin Galactic)——则 symbol_valid=false。
2. 新闻主体若是未上市、尚未完成 IPO 的公司,无法在二级市场买到,symbol_valid=false。
3. 当前股价/市值与新闻内容的量级是否自洽?若新闻提到的股价、IPO 定价、目标价、市值与当前报价严重矛盾(例如新闻称 IPO 定价 175 美元而当前报价只有 4.59 美元),说明代码映射有误或数据异常,symbol_valid=false。
4. 公司档案缺失或与新闻明显对不上时,宁可错过,symbol_valid=false。
symbol_valid=false 时 action 必须为 hold,并在 validation_reason 中用中文说明核验不通过的原因。

第二步,核验通过后再做交易决策:
- 只能做多,不能做空;只能卖出当前已持有的股票。
- buy 时 fraction 表示动用可用现金的比例(0~1);sell 时 fraction 表示卖出该股票持仓的比例(0~1)。
- 利好且档位高(第1、2档)可考虑买入;利空且已持有该股票可考虑卖出;信号弱或不确定时选择 hold。
- 结合实时行情判断:若今日已大幅高开/拉升,利好可能已被定价,应降低仓位或 hold;股价异常波动、流动性极差(日均成交量过低)时保持谨慎。
- 注意分散风险,单只股票仓位不宜过重。
- buy 时必须同时设定止损与止盈位:stop_loss_percent 表示跌破成本价该百分比时自动止损(3~15 之间),take_profit_percent 表示涨过成本价该百分比时自动止盈(5~30 之间)。新闻影响越强、确定性越高,止盈可设得越远;股票波动性越大,止损应留出越多空间。
- reason 用中文写明本次决策依据(引用新闻要点,80字以内)。

必须严格返回 JSON:
{
  "symbol_valid": true 或 false,
  "validation_reason": "标的核验结论(中文,50字以内)",
  "action": "buy" | "sell" | "hold",
  "fraction": 0.0 到 1.0,
  "stop_loss_percent": 3 到 15 之间的数字,   // 仅 buy 时有意义
  "take_profit_percent": 5 到 30 之间的数字, // 仅 buy 时有意义
  "reason": "中文决策理由"
}`;

/** 用 DeepSeek 基于新闻分析 + 公司档案 + 实时行情 + 组合状态做交易决策 */
export async function decideTrade({ analysis, article, quote, profile, portfolio }) {
  const position = portfolio.positions.find((p) => p.symbol === analysis.symbol);
  const user = JSON.stringify(
    {
      新闻标题: article.title,
      新闻摘要: (article.text_content || '').slice(0, 600) || null,
      分析: {
        股票: analysis.symbol,
        方向: analysis.sentiment === 'bullish' ? '利好' : '利空',
        档位: `第${analysis.tier}档`,
        影响程度: analysis.impact_strength === 'high' ? '大' : '小',
        影响范围: analysis.impact_scope === 'wide' ? '大' : '小',
        置信度: analysis.confidence,
        理由: analysis.reasoning,
      },
      公司档案: profile
        ? {
            公司名称: profile.companyName || null,
            交易所: profile.exchangeFullName || profile.exchange || null,
            板块: profile.sector || null,
            行业: profile.industry || null,
            市值: profile.marketCap ?? null,
            IPO日期: profile.ipoDate || null,
            是否正常交易: profile.isActivelyTrading ?? null,
            '52周区间': profile.range || null,
            日均成交量: profile.averageVolume ?? null,
          }
        : '未能获取公司档案,核验时请格外谨慎',
      实时行情: {
        报价对应公司: quote.name || null,
        当前价格: quote.effective_price ?? quote.price,
        市场时段: quote.session ?? 'regular',
        盘前盘后价: quote.extended_price ?? null,
        今日涨跌幅百分比: quote.changesPercentage ?? quote.changePercentage ?? null,
        今日成交量: quote.volume ?? null,
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

  // 标的核验未通过时,无论模型返回什么动作都强制 hold
  const symbolValid = result.symbol_valid !== false;
  const action =
    symbolValid && ['buy', 'sell', 'hold'].includes(result.action) ? result.action : 'hold';
  return {
    symbolValid,
    validationReason: result.validation_reason || '',
    action,
    fraction: clamp(result.fraction, 0, 1, 0),
    stopLossPercent: clamp(result.stop_loss_percent, 3, 15, 8),
    takeProfitPercent: clamp(result.take_profit_percent, 5, 30, 15),
    reason: result.reason || '',
  };
}

const EVENT_MATCH_SYSTEM_PROMPT = `你是一个金融新闻事件归并助手。同一个底层事件(同一份公告、同一项合作、同一份财报)经常被多家媒体用不同标题、不同角度重复报道。给你一条新分析出的新闻事件概要,以及该股票近期已记录的事件列表,判断这条新闻是否只是某个已有事件的重复报道或跟进报道。

判断标准:核心事实相同(同一公告/合作/数据/事件)即视为同一事件,即使标题措辞、报道角度、信息源完全不同。只有当新闻包含实质性的新事件(新的公告、新的进展、性质不同的事实)时才算新事件。拿不准时倾向于判定为重复(宁可少交易,不可重复交易)。

必须严格返回 JSON:
{
  "duplicate_of": 已有事件的 id(数字);不是重复报道则为 null,
  "reason": "中文简述判断依据(50字以内)"
}`;

/**
 * 事件溯源归并:判断新闻是否为既有事件的重复报道。
 * 返回 { duplicateOf: number|null, reason }。
 */
export async function matchEvent({ symbol, eventSummary, articleTitle, recentEvents }) {
  const user = JSON.stringify(
    {
      股票: symbol,
      新事件概要: eventSummary,
      新闻标题: articleTitle,
      已记录事件: recentEvents.map((e) => ({
        id: e.id,
        概要: e.summary,
        记录时间: e.created_at,
        已触发交易: e.traded,
        报道数: e.article_count,
      })),
    },
    null,
    1
  );

  const result = await chatJSON([
    { role: 'system', content: EVENT_MATCH_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]);

  const dupId = Number(result.duplicate_of);
  return {
    duplicateOf: Number.isFinite(dupId) && dupId > 0 ? dupId : null,
    reason: result.reason || '',
  };
}
