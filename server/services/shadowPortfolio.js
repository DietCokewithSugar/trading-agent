// 影子组合 / 消融实验(017):与实盘并行记账的多套虚拟组合,每套关闭一层防线,
// 用事后净值对比回答"哪一层真的贡献收益,哪一层只是减少交易"。
//
// 变体语义(也写在 017 迁移注释里):
//   no_risk_officer  跟随实盘成交镜像记账,但风控官否决/缩仓的买入按否决前方案照样执行
//   no_macro_filter  跟随实盘镜像(用宏观钳制前的仓位),宏观层拦截(regime 过滤/冲击/
//                    黑窗/预算钳制/开仓配额)的买入按确定性仓位重放
//   immediate_trade  独立组合:可交易利好信号到达即按确定性仓位买入(不经候选池/LLM/风控官),
//                    利空信号清仓——对照实盘可度量候选池+LLM 决策链的净价值
//   equal_weight     独立组合:可交易信号一律按固定比例等权买入,检验 LLM 仓位是否有效
//   spy_benchmark    启用时一次性全仓买入 SPY 并持有
//   cash             纯现金基准
//
// 设计约束:
//   - 纯观测层,fail-open:任何失败只告警,绝不影响交易主链路;表缺失(未执行 017)整体停用。
//   - 零额外 LLM 成本:实盘没有调用 LLM 的路径(宏观拦截重放/即时成交/等权)一律用
//     确定性仓位(shadowBaseFraction × sizing.js 档位/置信度/来源缩放),不是重放 LLM 决策。
//   - 写入非事务、进程内串行(enqueue 链),与实盘 withTradeLock 同思路;模拟盘可接受。
//   - 同一变体对同一条分析最多买入一次(variant+analysis_id 去重),防止宏观过滤逐轮重放、
//     留池候选后续真实成交镜像导致的重复买入。
import { supabase } from '../db.js';
import { config } from '../config.js';
import { getQuote, getQuotes, getMarketSession } from './fmp.js';
import { minutesSinceMarketOpen } from './marketCalendar.js';
import { computeFill } from './execution.js';
import { scaleFraction } from './sizing.js';
import { sanitizeProviderText } from './metrics.js';
import {
  computeShadowSpend,
  applyBuy,
  applySell,
  unscaleFraction,
  pickTopBlocked,
  valuePositions,
} from './shadowEngine.js';

export const SHADOW_VARIANTS = [
  'no_risk_officer',
  'no_macro_filter',
  'immediate_trade',
  'equal_weight',
  'spy_benchmark',
  'cash',
];

/** 跟随实盘成交镜像记账的变体(独立策略变体与基准不镜像) */
const MIRROR_VARIANTS = ['no_risk_officer', 'no_macro_filter'];
/** 独立信号驱动的变体(自己的买卖逻辑,不跟随实盘) */
const SIGNAL_VARIANTS = ['immediate_trade', 'equal_weight'];

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

let tableMissing = false;

function isMissingTable(error) {
  return (
    error?.code === 'PGRST205' ||
    (/shadow_/.test(error?.message || '') &&
      /not find|does not exist|schema cache/i.test(error?.message || ''))
  );
}

function warnMissingOnce() {
  if (tableMissing) return;
  tableMissing = true;
  console.warn('[shadow] 影子组合表不可用,消融实验停用(请执行 017 迁移)');
}

export function isShadowAvailable() {
  return config.enableShadow && !tableMissing;
}

// 进程内串行链:所有改账操作排队执行,避免现金读-改-写交错;
// 钩子一律 fire-and-forget,失败只告警(纯观测层不允许影响交易主链路)
let chain = Promise.resolve();
function enqueue(label, fn) {
  if (!isShadowAvailable()) return Promise.resolve();
  const run = chain.then(fn).catch((err) => {
    if (isMissingTable(err)) warnMissingOnce();
    else console.warn(`[shadow] ${label} 失败: ${err.message}`);
  });
  chain = run;
  return run;
}

/** supabase 响应解包:错误时抛出(由 enqueue 统一告警);缺表错误标记停用 */
function unwrap(res, what) {
  if (res.error) {
    if (isMissingTable(res.error)) {
      warnMissingOnce();
    }
    throw new Error(`${what}: ${res.error.message}`);
  }
  return res.data;
}

/** 启动初始化:为每个变体补建资金行(已存在的不动);缺表时静默停用 */
export async function initShadowPortfolios() {
  if (!isShadowAvailable()) return;
  const rows = SHADOW_VARIANTS.map((variant) => ({
    variant,
    cash: config.initialCapital,
    initial_capital: config.initialCapital,
  }));
  const { error } = await supabase()
    .from('shadow_portfolios')
    .upsert(rows, { onConflict: 'variant', ignoreDuplicates: true });
  if (error) {
    if (isMissingTable(error)) warnMissingOnce();
    else console.warn(`[shadow] 初始化影子组合失败: ${error.message}`);
    return;
  }
  console.log(`[shadow] 影子组合就绪(${SHADOW_VARIANTS.length} 个变体)`);
  // SPY 基准建仓(报价不可用时留待快照循环重试)
  await enqueue('SPY 基准建仓', ensureBenchmarkPosition);
}

/** 管理后台重置后调用:清进程内状态并重建变体资金行 */
export function resetShadowState() {
  lastSnapshotAt = 0;
  tableMissing = false;
}

async function loadPortfolio(variant) {
  const res = await supabase()
    .from('shadow_portfolios')
    .select('*')
    .eq('variant', variant)
    .maybeSingle();
  return unwrap(res, `读取影子组合 ${variant}`);
}

async function loadPositions(variant) {
  const res = await supabase().from('shadow_positions').select('*').eq('variant', variant);
  return unwrap(res, `读取影子持仓 ${variant}`) || [];
}

/** 该变体是否已为这条分析买过(去重键 variant+analysis_id) */
async function hasBoughtAnalysis(variant, analysisId) {
  if (!analysisId) return false;
  const res = await supabase()
    .from('shadow_trades')
    .select('id')
    .eq('variant', variant)
    .eq('analysis_id', analysisId)
    .eq('side', 'buy')
    .limit(1);
  return Boolean(unwrap(res, '影子买入去重查询')?.length);
}

/** 影子组合估值:持仓按 60s 缓存报价(缺失退回平均成本)+ 现金 */
async function shadowValuation(variant, { portfolio = null, positions = null } = {}) {
  const state = portfolio || (await loadPortfolio(variant));
  if (!state) return null;
  const held = positions || (await loadPositions(variant));
  const quotes = held.length
    ? await getQuotes(held.map((p) => p.symbol), 60_000).catch(() => new Map())
    : new Map();
  const priceBySymbol = new Map(
    held.map((p) => {
      const q = quotes.get(p.symbol);
      return [p.symbol, q ? (q.effective_price ?? q.price) : Number(p.avg_cost)];
    })
  );
  const { positionsValue, totalValue } = valuePositions(held, priceBySymbol, state.cash);
  return { state, positions: held, priceBySymbol, positionsValue, totalValue };
}

/**
 * 影子买入(须在 enqueue 链内调用):估值 → 硬帽 → 成交(镜像用实盘成交价,
 * 否则按报价施加滑点)→ 记账。amount 不足下限/重复分析时静默跳过。
 */
async function shadowBuy(
  variant,
  {
    symbol,
    refPrice,
    quote = null,
    profile = null,
    fraction,
    stopLossPercent = null,
    takeProfitPercent = null,
    reason = null,
    trigger = 'news',
    newsId = null,
    analysisId = null,
    mirrorTradeId = null,
    fillPrice = null,
    benchmark = false,
  }
) {
  if (!(Number(refPrice) > 0)) return;
  if (analysisId && (await hasBoughtAnalysis(variant, analysisId))) return;

  const valuation = await shadowValuation(variant);
  if (!valuation) return;
  const existing = valuation.positions.find((p) => p.symbol === symbol);
  const existingValue = existing
    ? Number(valuation.priceBySymbol.get(symbol) ?? existing.avg_cost) * Number(existing.quantity)
    : 0;
  const spend = computeShadowSpend({
    fraction,
    cash: Number(valuation.state.cash),
    totalValue: valuation.totalValue,
    positionValue: existingValue,
    benchmark,
  });
  if (!spend) return;

  // 成交价:镜像直接用实盘成交价(同滑点);影子独立买入按报价模型施加滑点;基准按参考价
  let price = Number(fillPrice);
  if (!Number.isFinite(price) || price <= 0) {
    if (!benchmark && quote) {
      price = computeFill({
        side: 'buy',
        quote,
        profile,
        notional: spend,
        minutesSinceOpen: minutesSinceMarketOpen(),
      }).fillPrice;
    } else {
      price = round4(Number(refPrice));
    }
  }
  const quantity = round4(spend / price);
  const amount = round2(quantity * price);

  // 写入顺序:先记成交(去重依赖它),再改持仓与现金;非事务 best-effort,模拟盘可接受
  unwrap(
    await supabase().from('shadow_trades').insert({
      variant,
      symbol,
      side: 'buy',
      quantity,
      price,
      amount,
      reason: reason ? sanitizeProviderText(String(reason).slice(0, 300)) : null,
      trigger,
      news_id: newsId,
      analysis_id: analysisId,
      mirror_trade_id: mirrorTradeId,
    }),
    `影子买入记录 ${variant}/${symbol}`
  );
  const next = applyBuy(existing || null, { quantity, amount, stopLossPercent, takeProfitPercent });
  unwrap(
    await supabase()
      .from('shadow_positions')
      .upsert(
        { variant, symbol, ...next, updated_at: new Date().toISOString() },
        { onConflict: 'variant,symbol' }
      ),
    `影子持仓更新 ${variant}/${symbol}`
  );
  unwrap(
    await supabase()
      .from('shadow_portfolios')
      .update({
        cash: round2(Number(valuation.state.cash) - amount),
        updated_at: new Date().toISOString(),
      })
      .eq('variant', variant),
    `影子现金更新 ${variant}`
  );
  console.log(`[shadow] ${variant} 买入 ${symbol} ${quantity} 股 @ $${price}($${amount})`);
}

/** 影子卖出(须在 enqueue 链内调用):未持有时静默跳过 */
async function shadowSell(
  variant,
  { symbol, refPrice, quote = null, fraction = 1, reason = null, trigger = 'news', mirrorTradeId = null, fillPrice = null }
) {
  const state = await loadPortfolio(variant);
  if (!state) return;
  const res = await supabase()
    .from('shadow_positions')
    .select('*')
    .eq('variant', variant)
    .eq('symbol', symbol)
    .maybeSingle();
  const position = unwrap(res, `读取影子持仓 ${variant}/${symbol}`);
  if (!position || Number(position.quantity) <= 0) return;

  let price = Number(fillPrice);
  if (!Number.isFinite(price) || price <= 0) {
    if (quote) {
      const ref = quote.effective_price ?? quote.price;
      price = computeFill({
        side: 'sell',
        quote,
        profile: null,
        notional: Number(position.quantity) * fraction * ref,
        minutesSinceOpen: minutesSinceMarketOpen(),
      }).fillPrice;
    } else {
      price = round4(Number(refPrice));
    }
  }
  if (!(price > 0)) return;

  const settle = applySell(position, fraction, price);
  unwrap(
    await supabase().from('shadow_trades').insert({
      variant,
      symbol,
      side: 'sell',
      quantity: settle.quantity,
      price,
      amount: settle.amount,
      reason: reason ? sanitizeProviderText(String(reason).slice(0, 300)) : null,
      trigger,
      realized_pnl: settle.realizedPnl,
      mirror_trade_id: mirrorTradeId,
    }),
    `影子卖出记录 ${variant}/${symbol}`
  );
  if (settle.remaining === 0) {
    unwrap(
      await supabase().from('shadow_positions').delete().eq('variant', variant).eq('symbol', symbol),
      `影子持仓删除 ${variant}/${symbol}`
    );
  } else {
    unwrap(
      await supabase()
        .from('shadow_positions')
        .update({ quantity: settle.remaining, updated_at: new Date().toISOString() })
        .eq('variant', variant)
        .eq('symbol', symbol),
      `影子持仓更新 ${variant}/${symbol}`
    );
  }
  unwrap(
    await supabase()
      .from('shadow_portfolios')
      .update({
        cash: round2(Number(state.cash) + settle.amount),
        updated_at: new Date().toISOString(),
      })
      .eq('variant', variant),
    `影子现金更新 ${variant}`
  );
  console.log(
    `[shadow] ${variant} 卖出 ${symbol} ${settle.quantity} 股 @ $${price}(盈亏 $${settle.realizedPnl})`
  );
}

// ── 信号钩子(trader/allocator 调用,全部 fire-and-forget)──

/** 可交易利好信号(已过档位/置信/去重/准入门槛):独立变体在此即时建仓 */
export function onBullishSignal({ article, analysisRow, quote, profile, price }) {
  if (!isShadowAvailable()) return;
  const base = {
    symbol: analysisRow.symbol,
    refPrice: price,
    quote,
    profile,
    newsId: article?.id ?? null,
    analysisId: analysisRow.id ?? null,
    ...config.shadowDefaultStops,
  };
  const { sized } = scaleFraction({
    fraction: config.shadowBaseFraction,
    tier: analysisRow.tier,
    confidence: analysisRow.confidence,
    sourceScore: article?.source_score ?? null,
  });
  enqueue('即时成交买入', () =>
    shadowBuy('immediate_trade', {
      ...base,
      fraction: sized,
      reason: `信号即时成交(消融:无候选池/LLM 决策,确定性仓位 ${sized})`,
    })
  );
  enqueue('等权买入', () =>
    shadowBuy('equal_weight', {
      ...base,
      fraction: config.shadowEqualWeightFraction,
      reason: `信号等权买入(消融:固定比例 ${config.shadowEqualWeightFraction})`,
    })
  );
}

/** 可交易利空信号:独立变体清仓同票(实盘镜像由 mirrorSell 覆盖跟随型变体) */
export function onBearishSignal({ analysisRow, quote, price }) {
  if (!isShadowAvailable()) return;
  for (const variant of SIGNAL_VARIANTS) {
    enqueue(`${variant} 利空清仓`, () =>
      shadowSell(variant, {
        symbol: analysisRow.symbol,
        refPrice: price,
        quote,
        fraction: 1,
        reason: `利空信号清仓(第${analysisRow.tier}档)`,
      })
    );
  }
}

/** 风控官否决/审批失败:no_risk_officer 变体按否决前方案照样买入 */
export function onOfficerVeto({
  symbol,
  quote,
  profile,
  price,
  fraction,
  stopLossPercent,
  takeProfitPercent,
  vetoReason,
  article,
  analysisRow,
}) {
  if (!isShadowAvailable()) return;
  enqueue('风控官否决重放', () =>
    shadowBuy('no_risk_officer', {
      symbol,
      refPrice: price,
      quote,
      profile,
      fraction,
      stopLossPercent,
      takeProfitPercent,
      newsId: article?.id ?? null,
      analysisId: analysisRow?.id ?? null,
      reason: `风控官否决但本组合无风控官:${vetoReason || ''}`,
    })
  );
}

/** 锁内宏观硬风控拒绝(macro_shock/开仓配额/三重钳制):no_macro_filter 照样买入 */
export function onMacroClampedBuy({
  symbol,
  quote,
  fraction,
  stopLossPercent,
  takeProfitPercent,
  reason,
  newsId,
  analysisId,
}) {
  if (!isShadowAvailable()) return;
  enqueue('宏观钳制重放', () =>
    shadowBuy('no_macro_filter', {
      symbol,
      refPrice: quote ? (quote.effective_price ?? quote.price) : null,
      quote,
      fraction,
      stopLossPercent,
      takeProfitPercent,
      newsId,
      analysisId,
      reason: `宏观硬风控拦截(${reason})但本组合无宏观过滤`,
    })
  );
}

/**
 * 分配器宏观拦截的候选(regime 档位过滤/宏观冲击/数据发布黑窗):
 * no_macro_filter 按当前分取前 maxAllocationsPerRun 个用确定性仓位重放
 * (这些候选没走到 LLM 决策,无 LLM 仓位可用)。已买过的分析自动去重。
 */
export function onMacroFilteredCandidates(candidates, note) {
  if (!isShadowAvailable() || !candidates?.length) return;
  enqueue('宏观过滤重放', async () => {
    const ids = candidates.map((c) => c.analysis_id).filter(Boolean);
    let bought = new Set();
    if (ids.length) {
      const res = await supabase()
        .from('shadow_trades')
        .select('analysis_id')
        .eq('variant', 'no_macro_filter')
        .eq('side', 'buy')
        .in('analysis_id', ids);
      bought = new Set((unwrap(res, '宏观过滤重放去重查询') || []).map((r) => r.analysis_id));
    }
    const picked = pickTopBlocked(candidates, {
      max: config.maxAllocationsPerRun,
      excludeAnalysisIds: bought,
    });
    for (const candidate of picked) {
      const quote = await getQuote(candidate.symbol).catch(() => null);
      if (!quote) continue;
      const { sized } = scaleFraction({
        fraction: config.shadowBaseFraction,
        tier: candidate.tier,
        confidence: candidate.confidence,
        sourceScore: candidate.source_score ?? null,
      });
      await shadowBuy('no_macro_filter', {
        symbol: candidate.symbol,
        refPrice: quote.effective_price ?? quote.price,
        quote,
        fraction: sized,
        ...config.shadowDefaultStops,
        newsId: candidate.news_id ?? null,
        analysisId: candidate.analysis_id ?? null,
        reason: `${note}但本组合无宏观过滤(确定性仓位 ${sized})`,
      });
    }
  });
}

// ── 实盘成交镜像(trader 调用)──

/**
 * 实盘买入成交镜像:跟随型变体按"自己组合总值 × 还原后的比例"等比买入。
 *   no_risk_officer:实际成交比例 ÷ 风控官缩仓系数(其余约束原样保留)
 *   no_macro_filter:宏观钳制前的请求比例(风控官/冲突缩放保留,影子引擎本身无宏观钳制)
 */
export function mirrorBuy(trade, { effectiveFraction, requestFraction, officerScale = 1, stopLossPercent = null, takeProfitPercent = null } = {}) {
  if (!isShadowAvailable() || !trade) return;
  const plans = [
    { variant: 'no_risk_officer', fraction: unscaleFraction(effectiveFraction, officerScale) },
    { variant: 'no_macro_filter', fraction: round4(Number(requestFraction) || 0) },
  ];
  for (const plan of plans) {
    if (!(plan.fraction > 0)) continue;
    enqueue(`${plan.variant} 镜像买入`, () =>
      shadowBuy(plan.variant, {
        symbol: trade.symbol,
        refPrice: trade.price,
        fillPrice: trade.price,
        fraction: plan.fraction,
        stopLossPercent,
        takeProfitPercent,
        trigger: trade.trigger || 'news',
        newsId: trade.news_id ?? null,
        analysisId: trade.analysis_id ?? null,
        mirrorTradeId: trade.id,
        reason: trade.reason ?? null,
      })
    );
  }
}

/** 实盘卖出成交镜像:跟随型变体按同等比例卖出自己的持仓(未持有自动跳过) */
export function mirrorSell(trade, { fraction = 1 } = {}) {
  if (!isShadowAvailable() || !trade) return;
  for (const variant of MIRROR_VARIANTS) {
    enqueue(`${variant} 镜像卖出`, () =>
      shadowSell(variant, {
        symbol: trade.symbol,
        refPrice: trade.price,
        fillPrice: trade.price,
        fraction,
        trigger: trade.trigger || 'news',
        mirrorTradeId: trade.id,
        reason: trade.reason ?? null,
      })
    );
  }
}

// ── 后台循环(scheduler 调用)──

let stopsRunning = false;

/** 影子持仓止损/止盈监控:与实盘 riskMonitor 同口径(全仓卖出),休市跳过 */
export async function checkShadowStops() {
  if (!isShadowAvailable() || stopsRunning) return;
  if (getMarketSession() === 'closed') return;
  stopsRunning = true;
  try {
    const res = await supabase()
      .from('shadow_positions')
      .select('*')
      .or('stop_loss.not.is.null,take_profit.not.is.null');
    const positions = unwrap(res, '读取影子持仓');
    if (!positions?.length) return;

    // 同一票多个变体共用一次报价(25s 缓存,与实盘监控同步常常直接命中)
    const quoteBySymbol = new Map();
    for (const pos of positions) {
      if (!quoteBySymbol.has(pos.symbol)) {
        quoteBySymbol.set(pos.symbol, await getQuote(pos.symbol, 25_000).catch(() => null));
      }
      const quote = quoteBySymbol.get(pos.symbol);
      if (!quote) continue;
      const price = quote.effective_price ?? quote.price;
      const stop = pos.stop_loss !== null && pos.stop_loss !== undefined ? Number(pos.stop_loss) : null;
      const take = pos.take_profit !== null && pos.take_profit !== undefined ? Number(pos.take_profit) : null;

      let trigger = null;
      if (stop !== null && price <= stop) trigger = 'stop_loss';
      else if (take !== null && price >= take) trigger = 'take_profit';
      if (!trigger) continue;

      const reason =
        trigger === 'stop_loss'
          ? `影子止损:现价 $${price} 跌破止损价 $${stop}`
          : `影子止盈:现价 $${price} 触及止盈价 $${take}`;
      await enqueue(`${pos.variant} 止损止盈`, () =>
        shadowSell(pos.variant, {
          symbol: pos.symbol,
          refPrice: price,
          quote,
          fraction: 1,
          trigger,
          reason,
        })
      );
    }
  } catch (err) {
    if (isMissingTable(err)) warnMissingOnce();
    else console.warn(`[shadow] 止损监控失败: ${err.message}`);
  } finally {
    stopsRunning = false;
  }
}

/** SPY 基准建仓(初始化或快照循环重试):有现金且未持有 SPY 时全仓买入 */
async function ensureBenchmarkPosition() {
  const state = await loadPortfolio('spy_benchmark');
  if (!state || Number(state.cash) < config.minOrderAmount) return;
  const positions = await loadPositions('spy_benchmark');
  if (positions.some((p) => p.symbol === 'SPY')) return;
  const quote = await getQuote('SPY').catch(() => null);
  if (!quote) return;
  await shadowBuy('spy_benchmark', {
    symbol: 'SPY',
    refPrice: quote.effective_price ?? quote.price,
    fillPrice: quote.effective_price ?? quote.price,
    fraction: 1,
    trigger: 'benchmark',
    benchmark: true,
    reason: '基准:全仓买入并持有 SPY',
  });
}

let lastSnapshotAt = 0;

/** 影子净值快照:搭车主快照循环,自行限频到 shadowSnapshotMinutes 一次 */
export async function takeShadowSnapshots() {
  if (!isShadowAvailable()) return;
  if (Date.now() - lastSnapshotAt < config.shadowSnapshotMinutes * 60_000) return;
  lastSnapshotAt = Date.now();
  await enqueue('净值快照', async () => {
    await ensureBenchmarkPosition().catch(() => {});
    const [pfRes, posRes] = await Promise.all([
      supabase().from('shadow_portfolios').select('*'),
      supabase().from('shadow_positions').select('*'),
    ]);
    const portfolios = unwrap(pfRes, '读取影子组合');
    if (!portfolios?.length) return;
    const positions = unwrap(posRes, '读取影子持仓') || [];
    const symbols = [...new Set(positions.map((p) => p.symbol))];
    const quotes = symbols.length
      ? await getQuotes(symbols, 60_000).catch(() => new Map())
      : new Map();
    const priceBySymbol = new Map(
      symbols.map((s) => {
        const q = quotes.get(s);
        return [s, q ? (q.effective_price ?? q.price) : null];
      })
    );
    const rows = portfolios.map((pf) => {
      const held = positions.filter((p) => p.variant === pf.variant);
      const prices = new Map(
        held.map((p) => [p.symbol, priceBySymbol.get(p.symbol) ?? Number(p.avg_cost)])
      );
      const { positionsValue, totalValue } = valuePositions(held, prices, pf.cash);
      return {
        variant: pf.variant,
        cash: Number(pf.cash),
        positions_value: positionsValue,
        total_value: totalValue,
      };
    });
    unwrap(await supabase().from('shadow_snapshots').insert(rows), '写入影子快照');
  });
}

// ── 查询(/api/shadow)──

/** 影子组合总览:各变体实时估值 + 净值序列 + 最近影子成交;不可用返回 null */
export async function getShadowOverview({ hours = 24 * 7 } = {}) {
  if (!isShadowAvailable()) return null;
  try {
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const [pfRes, posRes, recentRes] = await Promise.all([
      supabase().from('shadow_portfolios').select('*').order('variant'),
      supabase().from('shadow_positions').select('*'),
      supabase()
        .from('shadow_trades')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(30),
    ]);
    const portfolios = unwrap(pfRes, '读取影子组合');
    if (!portfolios?.length) return { variants: [], series: {}, recent_trades: [] };
    const positions = unwrap(posRes, '读取影子持仓') || [];
    const recentTrades = unwrap(recentRes, '读取影子成交') || [];

    const symbols = [...new Set(positions.map((p) => p.symbol))];
    const quotes = symbols.length
      ? await getQuotes(symbols, 60_000).catch(() => new Map())
      : new Map();

    // 各变体成交笔数(head 计数,轻量)
    const counts = await Promise.all(
      portfolios.map(async (pf) => {
        const { count, error } = await supabase()
          .from('shadow_trades')
          .select('id', { count: 'exact', head: true })
          .eq('variant', pf.variant);
        return error ? null : (count ?? 0);
      })
    );

    const variants = portfolios.map((pf, i) => {
      const held = positions
        .filter((p) => p.variant === pf.variant)
        .map((p) => {
          const q = quotes.get(p.symbol);
          const price = q ? (q.effective_price ?? q.price) : Number(p.avg_cost);
          const marketValue = price * Number(p.quantity);
          const costBasis = Number(p.avg_cost) * Number(p.quantity);
          return {
            symbol: p.symbol,
            quantity: Number(p.quantity),
            avg_cost: Number(p.avg_cost),
            current_price: price,
            market_value: round2(marketValue),
            unrealized_pnl_percent:
              costBasis > 0 ? round2(((marketValue - costBasis) / costBasis) * 100) : 0,
          };
        });
      const positionsValue = round2(held.reduce((sum, p) => sum + p.market_value, 0));
      const totalValue = round2(positionsValue + Number(pf.cash));
      const initial = Number(pf.initial_capital);
      return {
        variant: pf.variant,
        started_at: pf.started_at,
        cash: Number(pf.cash),
        initial_capital: initial,
        positions_value: positionsValue,
        total_value: totalValue,
        pnl: round2(totalValue - initial),
        pnl_percent: initial > 0 ? round2(((totalValue - initial) / initial) * 100) : 0,
        positions: held,
        trades_count: counts[i],
      };
    });

    // 净值序列:采样 RPC 优先,缺失时退回普通查询(各变体 ≤300 点)
    let snapRows;
    const rpc = await supabase().rpc('shadow_snapshots_sampled', {
      p_since: since,
      p_max_points: 300,
    });
    if (!rpc.error) {
      snapRows = rpc.data || [];
    } else {
      const plain = await supabase()
        .from('shadow_snapshots')
        .select('variant, total_value, created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .limit(1800);
      snapRows = unwrap(plain, '读取影子快照') || [];
    }
    const series = {};
    for (const row of snapRows) {
      if (!series[row.variant]) series[row.variant] = [];
      series[row.variant].push({ t: row.created_at, total_value: Number(row.total_value) });
    }

    return { variants, series, recent_trades: recentTrades };
  } catch (err) {
    if (isMissingTable(err)) {
      warnMissingOnce();
      return null;
    }
    throw err;
  }
}
