/**
 * 策略回测编排(032,IO 层,log 前缀 [backtest])。
 * 一轮回测 = bars(OHLC 日线)→ news(历史新闻分页)→ analyze(LLM 重析,
 * 逐文章缓存命中 backtest_analyses)→ simulate(AI 策略 + 五个经典基线)→ persist。
 * 观察层契约:单飞守卫(同一时刻至多一轮)、fail-open(缺表停用不断主链路)、
 * 进度经 SSE `backtest` 事件节流广播;错误落库前经 sanitizeProviderText 脱敏
 * (backtest_runs 公开可读,不得出现供应商名)。
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { supabase } from '../../db.js';
import { broadcast } from '../bus.js';
import { getHistoricalPricesFull, getHistoricalStockNews } from '../fmp.js';
import { analyzeArticle, PROMPT_VERSIONS } from '../deepseek.js';
import { normalizeFmpItem } from '../newsService.js';
import { estimateLlmCost, sanitizeProviderText } from '../metrics.js';
import { deriveSignals } from './aiSignals.js';
import { runAiStrategy, runTargetStrategy } from './engine.js';
import { BASELINE_STRATEGIES } from './strategies.js';
import { summarize } from './metrics.js';

/** 每标的独立账本的名义初始资金(论文口径:每票独立、全进全出,绝对值不影响百分比指标) */
const INITIAL_VALUE = 10000;
/** LLM 连续失败熔断阈值:分析器不可用时 fail fast,不再逐篇烧钱重试 */
const MAX_CONSECUTIVE_LLM_FAILURES = 10;
/** 历史新闻分页硬上限(防上游翻页异常导致的死循环) */
const MAX_NEWS_PAGES = 200;
/** 进度广播节流间隔 */
const PROGRESS_BROADCAST_MS = 1000;

export const backtestStatus = { running: false, runId: null };

// 每轮独立的中止令牌:管理重置只标记当前轮,不影响随后发起的新轮
let currentAbort = null;
let tableMissingWarned = false;
let cacheMissingWarned = false;
let lastProgressBroadcast = 0;

function isMissingTable(error) {
  return (
    error?.code === 'PGRST205' ||
    (/backtest_/.test(error?.message || '') &&
      /not find|does not exist|schema cache/i.test(error?.message || ''))
  );
}

function warnTableMissingOnce() {
  if (tableMissingWarned) return;
  tableMissingWarned = true;
  console.warn('[backtest] backtest_runs 表缺失(未执行 032 迁移),回测功能停用');
}

function warnCacheMissingOnce() {
  if (cacheMissingWarned) return;
  cacheMissingWarned = true;
  console.warn('[backtest] backtest_analyses 表缺失(未执行 032 迁移),分析缓存停用 —— 每轮全量 LLM 重析');
}

function broadcastProgress(runId, status, progress, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastProgressBroadcast < PROGRESS_BROADCAST_MS) return;
  lastProgressBroadcast = now;
  broadcast('backtest', { run_id: runId, status, ...progress });
}

async function updateRun(runId, patch) {
  try {
    const { error } = await supabase().from('backtest_runs').update(patch).eq('id', runId);
    if (error) throw error;
  } catch (err) {
    if (isMissingTable(err)) warnTableMissingOnce();
    else console.warn(`[backtest] 运行行更新失败: ${err.message}`);
  }
}

/** 简单并发池:并发 worker 消费同一游标;fatal/中止置位后不再取新任务(在飞的自然收尾) */
async function runPool(items, concurrency, worker, abort = { aborted: false }) {
  let cursor = 0;
  let fatal = null;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length && !fatal && !abort.aborted) {
      const idx = cursor;
      cursor += 1;
      try {
        await worker(items[idx], idx);
      } catch (err) {
        fatal = err;
      }
    }
  });
  await Promise.all(lanes);
  if (fatal) throw fatal;
  if (abort.aborted) throw new Error('回测被管理操作中止');
}

/** 读取某标的在窗口内的全部缓存分析行(按 symbol+published_at 索引分页,内存按 url 匹配) */
async function loadCachedAnalyses(symbol, from, to) {
  const map = new Map();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase()
      .from('backtest_analyses')
      .select('*')
      .eq('symbol', symbol)
      .eq('prompt_version', PROMPT_VERSIONS.analyst)
      // ±1 天缓冲:published_at 为 UTC,窗口边界按 ET 日期,宽取无害(按 url 精确匹配)
      .gte('published_at', `${from}T00:00:00-12:00`)
      .lte('published_at', `${to}T23:59:59+12:00`)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) {
      if (isMissingTable(error)) {
        warnCacheMissingOnce();
        return map;
      }
      throw new Error(error.message);
    }
    for (const row of data || []) map.set(row.url, row);
    if (!data || data.length < PAGE) return map;
  }
}

/** 分析结果写入缓存(fail-open:写失败只告警,结果仍在内存中参与本轮模拟) */
async function saveCachedAnalysis(row) {
  try {
    const { error } = await supabase()
      .from('backtest_analyses')
      .upsert(row, { onConflict: 'url,symbol,prompt_version', ignoreDuplicates: true });
    if (error) throw error;
  } catch (err) {
    if (isMissingTable(err)) warnCacheMissingOnce();
    else console.warn(`[backtest] 分析缓存写入失败: ${err.message}`);
  }
}

/** 'YYYY-MM-DD' + n 天(纯日历运算,暖机回退用;与 aiSignals.js 私有实现同式) */
function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 指标暖机根数:取各基线中最长的收敛需求(MACD 慢线+信号线 / SMA 慢线 / ZMR 窗口 /
 * RSI 首值 / KDJ 窗口)加 5 根余量(默认参数下 = 40)。日线预取从窗口起点向前回退
 * 约 warmupBars×1.6+10 个日历日(交易日→日历日换算 + 假日余量)——否则短窗口
 * (如 1 个月 21 根)会被暖机期整段吃掉,MACD/SMA 全程无信号。
 */
function warmupBarCount(params) {
  const { macd = {}, sma = {}, zmr = {}, rsi = {}, kdj = {} } = params || {};
  return (
    Math.max(
      (macd.slow ?? 26) + (macd.signal ?? 9),
      sma.slow ?? 30,
      zmr.period ?? 20,
      (rsi.period ?? 14) + 1,
      kdj.period ?? 9
    ) + 5
  );
}

/** 抓取一个标的在窗口内的全部历史新闻(分页至短页),按 url 去重 */
async function fetchSymbolNews(symbol, from, to, budget) {
  const byUrl = new Map();
  const limit = 100;
  for (let page = 0; page < MAX_NEWS_PAGES; page++) {
    const items = await getHistoricalStockNews(symbol, from, to, { page, limit });
    for (const item of items) {
      const article = normalizeFmpItem(item, 'fmp-stock');
      if (!article.url || byUrl.has(article.url)) continue;
      byUrl.set(article.url, article);
      if (byUrl.size + budget.used > budget.max) {
        throw new Error(
          `历史新闻总量超过上限 ${budget.max} 篇(${symbol} 尚未抓完),请缩小时间窗口或减少标的后重试`
        );
      }
    }
    if (items.length < limit) break;
  }
  budget.used += byUrl.size;
  return [...byUrl.values()];
}

/**
 * 发起一轮回测:插入 running 行后异步执行,立即返回 { runId }。
 * 参数校验由路由层完成;这里只负责单飞与生命周期。
 */
export async function startBacktest({ symbols, from, to, costBps }) {
  if (backtestStatus.running) throw Object.assign(new Error('当前已有一轮回测在运行中'), { status: 409 });
  const runId = randomUUID();
  backtestStatus.running = true;
  backtestStatus.runId = runId;
  const abort = { aborted: false };
  currentAbort = abort;
  const params = {
    symbols,
    from,
    to,
    cost_bps: costBps,
    initial_value: INITIAL_VALUE,
    // 门槛与策略参数快照:结果页展示 + 复现(env 变更后旧 run 仍可解释)
    thresholds: {
      trade_tier_threshold: config.tradeTierThreshold,
      min_final_confidence: config.minFinalConfidence,
      press_bullish_penalty: config.pressBullishPenalty,
      stop_loss_percent: config.stopLossPercent,
      take_profit_percent: config.takeProfitPercent,
      take_profit_step_percent: config.takeProfitStepPercent,
      max_hold_hours: config.maxHoldHours,
    },
    strategy_params: config.backtestParams,
    prompt_version: PROMPT_VERSIONS.analyst,
  };
  try {
    const { error } = await supabase()
      .from('backtest_runs')
      .insert({ id: runId, status: 'running', params, progress: { phase: 'bars' } });
    if (error) throw error;
  } catch (err) {
    backtestStatus.running = false;
    backtestStatus.runId = null;
    if (isMissingTable(err)) {
      warnTableMissingOnce();
      throw Object.assign(new Error('回测功能不可用:请先在数据库执行 032 迁移'), { status: 503 });
    }
    if (/未配置/.test(err.message)) {
      throw Object.assign(new Error('回测功能不可用:数据库未配置'), { status: 503 });
    }
    // 运行行是公开可读数据,错误同样走公开响应 —— 统一脱敏
    throw Object.assign(new Error(sanitizeProviderText(err.message)), { status: err.status });
  }
  runBacktest(runId, { symbols, from, to, costBps }, abort).catch((err) => {
    console.error(`[backtest] 运行 ${runId} 未捕获异常: ${err.message}`);
  });
  return { runId };
}

async function runBacktest(runId, { symbols, from, to, costBps }, abort) {
  const startedAt = Date.now();
  const llm = { calls: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
  try {
    // ── 阶段 1:OHLC 日线(带指标暖机预取)──
    const barsBySymbol = new Map();
    const symbolErrors = new Map();
    const warmupBars = warmupBarCount(config.backtestParams);
    const warmupFrom = shiftDate(from, -(Math.ceil(warmupBars * 1.6) + 10));
    for (const symbol of symbols) {
      broadcastProgress(runId, 'running', { phase: 'bars', symbol }, { force: true });
      try {
        const bars = await getHistoricalPricesFull(symbol, warmupFrom, to);
        // 有效性按窗口内 K 线判定(暖机段是新上市标的允许缺失的加分项,不是硬门槛)
        if (bars.filter((b) => b.date >= from).length < 2) {
          throw new Error('窗口内历史日线不足 2 根(窗口过短或标的无数据)');
        }
        barsBySymbol.set(symbol, bars);
      } catch (err) {
        console.warn(`[backtest] ${symbol} 日线获取失败: ${err.message}`);
        symbolErrors.set(symbol, `日线获取失败: ${sanitizeProviderText(err.message)}`);
      }
      if (abort.aborted) throw new Error('回测被管理操作中止');
    }
    if (barsBySymbol.size === 0) throw new Error('所有标的的历史日线均不可用');
    await updateRun(runId, { progress: { phase: 'news' } });

    // ── 阶段 2:历史新闻(总量护栏)──
    const articlesBySymbol = new Map();
    const budget = { used: 0, max: config.backtestMaxArticles };
    for (const symbol of barsBySymbol.keys()) {
      broadcastProgress(runId, 'running', { phase: 'news', symbol, articles: budget.used }, { force: true });
      const articles = await fetchSymbolNews(symbol, from, to, budget);
      articlesBySymbol.set(symbol, articles);
      console.log(`[backtest] ${symbol} 窗口内历史新闻 ${articles.length} 篇(累计 ${budget.used})`);
      if (abort.aborted) throw new Error('回测被管理操作中止');
    }
    await updateRun(runId, { progress: { phase: 'analyze', total: budget.used, analyzed: 0 } });

    // ── 阶段 3:LLM 重析(缓存优先)──
    const analysesBySymbol = new Map();
    let analyzed = 0;
    let consecutiveFailures = 0;
    for (const [symbol, articles] of articlesBySymbol) {
      const cache = await loadCachedAnalyses(symbol, from, to);
      const rows = [];
      const pending = [];
      for (const article of articles) {
        const hit = cache.get(article.url);
        if (hit) {
          rows.push(hit);
          analyzed += 1;
        } else {
          pending.push(article);
        }
      }
      broadcastProgress(runId, 'running', { phase: 'analyze', symbol, analyzed, total: budget.used }, { force: true });
      await runPool(pending, config.backtestLlmConcurrency, async (article) => {
        let result;
        try {
          result = await analyzeArticle(
            { ...article, symbols: [symbol] },
            { purpose: 'backtest-analyst' }
          );
          consecutiveFailures = 0;
        } catch (err) {
          consecutiveFailures += 1;
          analyzed += 1;
          console.warn(`[backtest] 文章分析失败(连续 ${consecutiveFailures}): ${err.message}`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_LLM_FAILURES) {
            throw new Error(`LLM 分析连续失败 ${consecutiveFailures} 次,中止本轮回测`);
          }
          return; // 单篇失败跳过(不入信号,亦不写缓存)
        }
        llm.calls += 1;
        llm.promptTokens += result.llm?.promptTokens || 0;
        llm.completionTokens += result.llm?.completionTokens || 0;
        const row = {
          url: article.url,
          symbol,
          prompt_version: PROMPT_VERSIONS.analyst,
          published_at: article.published_at,
          title: article.title,
          source: article.source,
          source_domain: article.source_domain,
          source_score: article.source_score,
          publisher: article.publisher,
          relevant: result.relevant === true,
          analysis_symbol: result.symbol ? String(result.symbol).toUpperCase() : null,
          sentiment: result.sentiment,
          tier: result.tier,
          confidence: result.confidence,
          reasoning: result.reasoning || null,
          llm_prompt_tokens: result.llm?.promptTokens ?? null,
          llm_completion_tokens: result.llm?.completionTokens ?? null,
          llm_latency_ms: result.llm?.latencyMs ?? null,
        };
        rows.push(row);
        await saveCachedAnalysis(row);
        analyzed += 1;
        broadcastProgress(runId, 'running', { phase: 'analyze', symbol, analyzed, total: budget.used });
      }, abort);
      analysesBySymbol.set(symbol, rows);
      llm.cost = estimateLlmCost({ promptTokens: llm.promptTokens, completionTokens: llm.completionTokens });
      await updateRun(runId, {
        progress: { phase: 'analyze', symbol, analyzed, total: budget.used },
        llm_calls: llm.calls,
        llm_prompt_tokens: llm.promptTokens,
        llm_completion_tokens: llm.completionTokens,
        llm_cost_usd: llm.cost,
      });
    }

    // ── 阶段 4:模拟(AI + 五个基线)──
    broadcastProgress(runId, 'running', { phase: 'simulate' }, { force: true });
    const resultSymbols = {};
    for (const [symbol, bars] of barsBySymbol) {
      const rows = analysesBySymbol.get(symbol) || [];
      const { signals, dropped } = deriveSignals(rows, {
        symbol,
        tradeTierThreshold: config.tradeTierThreshold,
        minFinalConfidence: config.minFinalConfidence,
        pressBullishPenalty: config.pressBullishPenalty,
      });
      const strategies = {};
      strategies.ai = pack(
        runAiStrategy({
          bars,
          signals,
          initialValue: INITIAL_VALUE,
          costBps,
          stopLossPercent: config.stopLossPercent,
          takeProfitPercent: config.takeProfitPercent,
          takeProfitStepPercent: config.takeProfitStepPercent,
          maxHoldHours: config.maxHoldHours,
          windowStart: from,
        })
      );
      for (const [key, gen] of Object.entries(BASELINE_STRATEGIES)) {
        const targets = gen(bars, config.backtestParams);
        strategies[key] = pack(
          runTargetStrategy({
            bars,
            targets,
            initialValue: INITIAL_VALUE,
            costBps,
            entryAtFirstBar: key === 'buy_hold',
            windowStart: from,
          })
        );
      }
      // 元数据按窗口内 K 线计(暖机段只服务指标收敛,不进展示口径)
      const windowBars = bars.filter((b) => b.date >= from);
      resultSymbols[symbol] = {
        bars_count: windowBars.length,
        first_date: windowBars[0]?.date ?? null,
        last_date: windowBars[windowBars.length - 1]?.date ?? null,
        warmup_bars: bars.length - windowBars.length,
        articles: (articlesBySymbol.get(symbol) || []).length,
        signals: { count: signals.length, dropped, timeline: signals.slice(0, 200) },
        strategies,
      };
    }
    for (const [symbol, error] of symbolErrors) {
      resultSymbols[symbol] = { error };
    }

    // ── 阶段 5:落库 ──
    await updateRun(runId, {
      status: 'completed',
      result: { symbols: resultSymbols, initial_value: INITIAL_VALUE, duration_ms: Date.now() - startedAt },
      progress: { phase: 'done', analyzed, total: budget.used },
      llm_calls: llm.calls,
      llm_prompt_tokens: llm.promptTokens,
      llm_completion_tokens: llm.completionTokens,
      llm_cost_usd: llm.cost,
      completed_at: new Date().toISOString(),
    });
    console.log(
      `[backtest] 运行 ${runId} 完成:${barsBySymbol.size} 标的 / ${budget.used} 篇文章 / LLM ${llm.calls} 次(约 $${llm.cost}),耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`
    );
    broadcastProgress(runId, 'completed', { phase: 'done' }, { force: true });
  } catch (err) {
    console.error(`[backtest] 运行 ${runId} 失败: ${err.message}`);
    await updateRun(runId, {
      status: 'failed',
      error: sanitizeProviderText(err.message),
      llm_calls: llm.calls,
      llm_prompt_tokens: llm.promptTokens,
      llm_completion_tokens: llm.completionTokens,
      llm_cost_usd: estimateLlmCost({ promptTokens: llm.promptTokens, completionTokens: llm.completionTokens }),
      completed_at: new Date().toISOString(),
    });
    broadcastProgress(runId, 'failed', { phase: 'failed' }, { force: true });
  } finally {
    backtestStatus.running = false;
    backtestStatus.runId = null;
  }
}

/** 成交列表截断(公开 jsonb 结果的体积护栏);曲线本身 ≤ 窗口交易日数,无需截断 */
function pack({ equity, trades, endState }) {
  return {
    metrics: summarize({ equity, trades, initialValue: INITIAL_VALUE }),
    equity,
    trades: trades.slice(0, 500),
    trades_truncated: trades.length > 500,
    end_state: endState,
  };
}

/** 运行列表(轻量,不含 result 大字段);缺表/未配库 → { available: false } */
export async function listRuns(limit = 20) {
  try {
    const { data, error } = await supabase()
      .from('backtest_runs')
      .select('id, status, params, progress, error, llm_calls, llm_cost_usd, created_at, completed_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return { available: true, running: backtestStatus.running, runs: data || [] };
  } catch (err) {
    if (isMissingTable(err)) warnTableMissingOnce();
    return { available: false, running: false, runs: [] };
  }
}

/** 单轮全量结果;不存在/不可用返回 null */
export async function getRun(id) {
  try {
    const { data, error } = await supabase()
      .from('backtest_runs')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (err) {
    if (isMissingTable(err)) warnTableMissingOnce();
    return null;
  }
}

/** 启动时清理:上一进程遗留的 running 行标记为 failed(重启后无法续跑) */
export async function cleanupStaleRuns() {
  try {
    const { error } = await supabase()
      .from('backtest_runs')
      .update({ status: 'failed', error: '服务重启中断', completed_at: new Date().toISOString() })
      .eq('status', 'running');
    if (error) throw error;
  } catch (err) {
    // 缺表/未配库均静默(未启用回测的部署不该看到启动噪音)
    if (!isMissingTable(err) && !/未配置/.test(err.message)) {
      console.warn(`[backtest] 启动清理失败: ${err.message}`);
    }
  }
}

/**
 * 管理重置:请求中止在飞回测(backtest_runs 的清空由重置流程负责)。
 * 只标记中止令牌,不直接复位单飞状态 —— 在飞轮次会在下一个检查点自然收尾并释放,
 * 立即复位会造成新旧两轮并行(旧轮继续烧 LLM 且写入已被清空的运行行)。
 */
export function clearBacktestState() {
  if (currentAbort) currentAbort.aborted = true;
}
