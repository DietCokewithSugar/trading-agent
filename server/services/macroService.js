// 宏观事件管线:无个股指向的财经新闻 → LLM 宏观分类 → macro_events 落库。
// 纯观测+聚合输入层:本模块失败只影响宏观功能,绝不打断个股交易主链路。
import { supabase } from '../db.js';
import { config } from '../config.js';
import { analyzeMacroArticle } from './deepseek.js';
import { matchCalendarSurprise } from './macroCalendar.js';
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
