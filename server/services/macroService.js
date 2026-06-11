// 宏观事件管线:无个股指向的财经新闻 → LLM 宏观分类 → macro_events 落库。
// 纯观测+聚合输入层:本模块失败只影响宏观功能,绝不打断个股交易主链路。
import { supabase } from '../db.js';
import { config } from '../config.js';
import { analyzeMacroArticle, matchMacroEvent } from './deepseek.js';
import { matchCalendarSurprise } from './macroCalendar.js';
import { mergeMacroConfidence } from './macroRegime.js';
import { sanitizeProviderText } from './metrics.js';

const state = {
  tableMissing: false, // macro_events 表缺失(未执行 014 迁移),一次告警后停用
};

function isMissingTable(error) {
  return /does not exist|not find|schema cache/i.test(error?.message || '');
}

/** 该文章是否应走宏观分析管线(无个股指向的综合财经新闻) */
export function isMacroCandidate(article) {
  return config.enableMacro && !state.tableMissing
    && !(article.symbols?.length) && article.source === 'fmp-general';
}

/**
 * 宏观文章处理:LLM 分类 → 经济日历匹配回填数值 surprise → macro_events 落库。
 * 与宏观无关返回 null;表缺失一次告警后整体停用(候选走原有"不相关"路径)。
 */
export async function processMacroArticle(article) {
  const analysis = await analyzeMacroArticle(article);
  if (!analysis) return null;

  // 经济数据类事件尝试匹配日历回填数值意外幅度(best-effort,匹配不到为 null)
  const calendarMatch = matchCalendarSurprise(
    analysis.event_type,
    article.published_at ? new Date(article.published_at) : new Date()
  );

  const row = {
    news_id: article.id,
    event_type: analysis.event_type,
    macro_direction: analysis.macro_direction,
    surprise: calendarMatch?.surprise ?? null,
    surprise_direction: analysis.surprise_direction,
    rates_signal: analysis.rates_signal,
    inflation_signal: analysis.inflation_signal,
    growth_signal: analysis.growth_signal,
    affected_sectors: analysis.affected_sectors,
    market_impact_tier: analysis.market_impact_tier,
    confidence: analysis.confidence,
    // summary 出现在公共读表里,脱敏供应商名(LLM 偶尔会复述新闻里的转发渠道)
    summary: sanitizeProviderText(analysis.summary),
  };

  // 入库前事件归并:与近 72h 已记录宏观事件 LLM 比对,同一事件的重复报道只累计
  // 篇数与小幅增信,不插新行——防止 regime 风险分被重复报道线性叠加放大。
  // 判重任何失败 fail-open 照常插入:宏观层宁可分数略偏,不可丢掉真实风险信号
  // (与个股侧 fail-closed 相反——那边漏判会触发重复交易,这边只是评分输入)。
  try {
    const merged = await mergeDuplicateMacroEvent(row, article);
    if (merged) return merged;
  } catch (err) {
    console.warn(`[macro] 事件归并不可用(${err.message}),照常入库`);
  }

  const { data, error } = await supabase().from('macro_events').insert(row).select().single();
  if (error) {
    if (isMissingTable(error)) {
      state.tableMissing = true;
      console.warn('[macro] macro_events 表缺失(请执行 014 迁移),宏观分析停用');
      return null;
    }
    throw new Error(`宏观事件入库失败: ${error.message}`);
  }
  console.log(
    `[macro] ${data.event_type} ${data.macro_direction} 第${data.market_impact_tier}档 conf=${data.confidence}: ${data.summary}`
  );
  return data;
}

/**
 * 与近期宏观事件比对判重(候选不按 event_type 过滤——同一底层事件可能被归入
 * 不同类型,如中东冲突 → geopolitics vs energy,跨类型归并正是要抓的重复)。
 * 命中则更新原行并返回合并后的行(runCycle 照常 recomputeRegime);未命中返回 null。
 * created_at 不动:重复报道不刷新时间衰减,实质性新进展会被 LLM 判为新事件。
 */
async function mergeDuplicateMacroEvent(row, article) {
  const candidates = await listRecentMacroEvents(config.macroEventValidityHours, 20);
  if (!candidates?.length) return null;

  const { duplicateOf, reason } = await matchMacroEvent({
    summary: row.summary,
    eventType: row.event_type,
    articleTitle: article.title,
    recentEvents: candidates,
  });
  const dup = duplicateOf ? candidates.find((e) => e.id === duplicateOf) : null;
  if (!dup) return null;

  const update = {
    article_count: (dup.article_count || 1) + 1,
    confidence: mergeMacroConfidence(dup.confidence, row.confidence),
    updated_at: new Date().toISOString(),
  };
  const db = supabase();
  const { error } = await db.from('macro_events').update(update).eq('id', dup.id);
  if (error) {
    // 未执行 015 迁移:strip 掉缺失列只更 confidence 重试(去重照做,只是不计数)
    if (!/article_count|updated_at/.test(error.message)) throw new Error(error.message);
    const { error: retryErr } = await db
      .from('macro_events')
      .update({ confidence: update.confidence })
      .eq('id', dup.id);
    if (retryErr) throw new Error(retryErr.message);
  }
  console.log(
    `[macro] 重复报道归并 → 事件 #${dup.id}(第 ${update.article_count} 篇):${reason || dup.summary}`
  );
  return { ...dup, ...update };
}

/** 近 N 小时的宏观事件(regime 聚合与 /api/macro 用);表缺失返回 null */
export async function listRecentMacroEvents(hours, limit = 100) {
  if (state.tableMissing) return null;
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data, error } = await supabase()
    .from('macro_events')
    .select('*')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingTable(error)) {
      state.tableMissing = true;
      console.warn('[macro] macro_events 表缺失(请执行 014 迁移),宏观分析停用');
      return null;
    }
    throw new Error(`读取宏观事件失败: ${error.message}`);
  }
  return data || [];
}
