import { supabase } from '../db.js';
import { config } from '../config.js';
import { getStockNews, getGeneralNews, getPressReleases } from './fmp.js';
import { getYahooNews } from './yahoo.js';
import { analyzeArticle } from './deepseek.js';
import { resolveEvent, markEventTraded } from './eventService.js';
import { handleSignal } from './trader.js';
import { getPortfolio } from './portfolio.js';
import { broadcast } from './bus.js';
import { isHalted } from './halt.js';

export const cycleStatus = {
  running: false,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
};

function normalizeFmpItem(item, source) {
  return {
    url: item.url,
    title: item.title,
    text_content: item.text || '',
    source,
    publisher: item.publisher || item.site || source,
    image: item.image || null,
    symbols: item.symbol ? [String(item.symbol).toUpperCase()] : [],
    published_at: item.publishedDate ? new Date(item.publishedDate).toISOString() : null,
  };
}

function normalizeYahooItem(item) {
  return {
    url: item.url,
    title: item.title,
    text_content: item.text || '',
    source: 'yahoo',
    publisher: item.publisher,
    image: null,
    symbols: item.symbol ? [item.symbol] : [],
    published_at: item.publishedDate,
  };
}

/**
 * 抓取新闻源并去重入库,返回本次新增的文章。
 * 快速轮询(秒级)只抓最轻量的个股新闻;fullFetch=true 时附带综合新闻/公告/Yahoo RSS。
 */
async function fetchAndStoreNews({ fullFetch = false } = {}) {
  const sources = [
    getStockNews(40).then((items) => items.map((i) => normalizeFmpItem(i, 'fmp-stock'))),
  ];
  if (fullFetch) {
    sources.push(
      getGeneralNews(20).then((items) => items.map((i) => normalizeFmpItem(i, 'fmp-general'))),
      getPressReleases(20).then((items) => items.map((i) => normalizeFmpItem(i, 'fmp-press')))
    );
    if (config.enableYahoo) {
      const { positions } = await getPortfolio();
      const watchSymbols = [
        ...new Set([...config.watchlist, ...positions.map((p) => p.symbol)]),
      ];
      sources.push(getYahooNews(watchSymbols).then((items) => items.map(normalizeYahooItem)));
    }
  }

  const results = await Promise.allSettled(sources);
  const errors = [];
  let articles = [];
  for (const r of results) {
    if (r.status === 'fulfilled') articles = articles.concat(r.value);
    else errors.push(r.reason?.message || String(r.reason));
  }

  // 批内按 URL 去重
  const seen = new Set();
  const rows = articles.filter((a) => {
    if (!a.url || !a.title || seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });

  let inserted = [];
  if (rows.length) {
    // ignoreDuplicates: 数据库中已存在的 URL 直接跳过,返回的就是真正新增的文章
    const { data, error } = await supabase()
      .from('news_articles')
      .upsert(rows, { onConflict: 'url', ignoreDuplicates: true })
      .select();
    if (error) throw new Error(`新闻入库失败: ${error.message}`);
    inserted = data || [];
  }

  return { inserted, fetched: rows.length, errors };
}

/**
 * 分析积压队列:取近 24 小时内尚未分析过的文章(analyzed_at 为空),
 * 优先带股票代码的,其次按发布时间倒序。超过每轮上限的文章会留在队列中逐轮消化。
 */
async function getAnalysisBacklog(limit) {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data, error } = await supabase()
    .from('news_articles')
    .select('*')
    .is('analyzed_at', null)
    .gte('fetched_at', since)
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(limit * 3);
  if (error) throw new Error(`读取分析队列失败: ${error.message}`);
  return (data || [])
    .sort((a, b) => {
      const symDiff = (b.symbols?.length ? 1 : 0) - (a.symbols?.length ? 1 : 0);
      if (symDiff !== 0) return symDiff;
      return new Date(b.published_at || 0) - new Date(a.published_at || 0);
    })
    .slice(0, limit);
}

/** 标记文章已分析(含判定为不相关),使其退出积压队列;分析失败的不标记,下轮重试 */
async function markAnalyzed(articleId) {
  const { error } = await supabase()
    .from('news_articles')
    .update({ analyzed_at: new Date().toISOString() })
    .eq('id', articleId);
  // analyzed_at 列不存在(未执行 004 迁移)时静默跳过,此时积压队列本身也不可用
  if (error && !/analyzed_at/.test(error.message)) {
    console.warn(`[cycle] 标记文章 ${articleId} 已分析失败: ${error.message}`);
  }
}

/** 对一篇新文章执行 DeepSeek 分析并入库,返回分析行(不相关/中性返回 null) */
async function analyzeAndStore(article) {
  const analysis = await analyzeArticle(article);

  if (!analysis.relevant || !analysis.symbol) return null;

  const row = {
    news_id: article.id,
    symbol: analysis.symbol,
    company_name: analysis.company_name || null,
    sentiment: analysis.sentiment,
    tier: analysis.tier,
    impact_strength: analysis.impact_strength || null,
    impact_scope: analysis.impact_scope || null,
    confidence: typeof analysis.confidence === 'number' ? analysis.confidence : null,
    reasoning: analysis.reasoning || '',
    event_summary: analysis.event_summary || null,
    model: config.deepseekModel,
  };
  let { data, error } = await supabase().from('news_analyses').insert(row).select().single();
  // 兼容尚未执行 003 迁移的数据库:去掉 event_summary 列重试
  if (error && /event_summary/.test(error.message)) {
    const { event_summary, ...legacy } = row;
    ({ data, error } = await supabase().from('news_analyses').insert(legacy).select().single());
    if (!error) data.event_summary = event_summary;
  }
  if (error) throw new Error(`分析结果入库失败: ${error.message}`);
  return data;
}

/** 完整的一轮:抓新闻 → 分析 → 交易,并通过 SSE 实时推送各环节结果 */
export async function runCycle({ fullFetch = false } = {}) {
  // 管理后台正在重置数据时暂停,避免边删库边交易
  if (isHalted()) {
    return cycleStatus.lastResult;
  }
  if (cycleStatus.running) {
    return cycleStatus.lastResult;
  }
  cycleStatus.running = true;
  const startedAt = new Date();
  const summary = {
    startedAt: startedAt.toISOString(),
    fullFetch,
    newArticles: 0,
    analyzed: 0,
    signals: 0,
    deduped: 0,
    trades: 0,
    errors: [],
  };

  try {
    const { inserted, errors } = await fetchAndStoreNews({ fullFetch });
    summary.errors.push(...errors);
    summary.newArticles = inserted.length;
    if (inserted.length) {
      console.log(`[cycle] 新增新闻 ${inserted.length} 条`);
      broadcast('news', { count: inserted.length });
    }

    // 从积压队列取待分析文章(不局限于本轮新增,超上限的文章逐轮消化)
    let toAnalyze;
    try {
      toAnalyze = await getAnalysisBacklog(config.maxAnalyzePerCycle);
    } catch (err) {
      // 兼容尚未执行 004 迁移的数据库:退回只分析本轮新增
      console.warn(`[cycle] 积压队列不可用(${err.message}),退回仅分析本轮新增`);
      toAnalyze = inserted
        .sort((a, b) => {
          const symDiff = (b.symbols?.length ? 1 : 0) - (a.symbols?.length ? 1 : 0);
          if (symDiff !== 0) return symDiff;
          return new Date(b.published_at || 0) - new Date(a.published_at || 0);
        })
        .slice(0, config.maxAnalyzePerCycle);
    }

    for (const article of toAnalyze) {
      try {
        const analysisRow = await analyzeAndStore(article);
        await markAnalyzed(article.id);
        summary.analyzed += 1;
        if (!analysisRow) continue;
        broadcast('analysis', {
          id: analysisRow.id,
          symbol: analysisRow.symbol,
          sentiment: analysisRow.sentiment,
          tier: analysisRow.tier,
        });

        const actionable =
          analysisRow.sentiment !== 'neutral' &&
          analysisRow.tier !== null &&
          analysisRow.tier <= config.tradeTierThreshold &&
          (analysisRow.confidence === null || analysisRow.confidence >= 0.5);
        if (!actionable) continue;

        summary.signals += 1;

        // 事件溯源去重:同一底层事件的多渠道报道只允许触发一次交易
        const dedup = await resolveEvent(article, analysisRow);
        if (!dedup.proceed) {
          summary.deduped += 1;
          console.log(`[cycle] ${analysisRow.symbol} 跳过交易: ${dedup.reason}`);
          continue;
        }

        const trade = await handleSignal(article, analysisRow);
        if (trade) {
          summary.trades += 1;
          await markEventTraded(dedup.eventId, trade.id);
          broadcast('trade', trade);
        }
      } catch (err) {
        console.error(`[cycle] 处理文章失败 (${article.url}): ${err.message}`);
        summary.errors.push(err.message);
      }
    }

    summary.durationMs = Date.now() - startedAt.getTime();
    cycleStatus.lastResult = summary;
    cycleStatus.lastError = null;
    if (summary.newArticles || summary.analyzed) {
      console.log(
        `[cycle] 完成: 新增${summary.newArticles} 分析${summary.analyzed} 信号${summary.signals} 去重${summary.deduped} 成交${summary.trades} 用时${summary.durationMs}ms`
      );
    }
    broadcast('cycle', summary);
    return summary;
  } catch (err) {
    console.error(`[cycle] 本轮失败: ${err.message}`);
    cycleStatus.lastError = err.message;
    summary.errors.push(err.message);
    cycleStatus.lastResult = summary;
    return summary;
  } finally {
    cycleStatus.running = false;
    cycleStatus.lastRunAt = startedAt.toISOString();
  }
}
