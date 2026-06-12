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

// 016 迁移新增的可选列:旧库缺列时逐列剥离重试,各列只告警一次
const OPTIONAL_MACRO_COLUMNS = ['source_domain', 'source_score', 'source_domains'];
const missingMacroColumns = new Set();

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
    // 来源可信度与独立信源(016):eventWeight 乘来源分,macro_shock 触发需多信源佐证
    source_domain: article.source_domain ?? null,
    source_score: article.source_score ?? null,
    source_domains: article.source_domain ? [article.source_domain] : [],
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

  const payload = { ...row };
  for (const col of missingMacroColumns) delete payload[col];
  let { data, error } = await supabase().from('macro_events').insert(payload).select().single();
  // 016 未迁移:可选来源列逐列剥离重试,宏观事件照常入库
  while (error && /column|schema/i.test(error.message)) {
    const col = OPTIONAL_MACRO_COLUMNS.find((c) => c in payload && error.message.includes(c));
    if (!col) break;
    missingMacroColumns.add(col);
    console.warn(`[macro] macro_events 缺少 ${col} 列,已降级不记录(请执行 016 迁移)`);
    delete payload[col];
    ({ data, error } = await supabase().from('macro_events').insert(payload).select().single());
  }
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

  // 独立信源累加(016):新报道来自未见过的域名时记入 source_domains——
  // macro_shock 的佐证门以此判定"是否有第二个独立信源";来源分取历来最高
  //(低分小站首报、路透社跟进 → 事件可信度按路透社计,与个股侧交叉确认同思路)
  const knownDomains = new Set(
    [...(Array.isArray(dup.source_domains) ? dup.source_domains : []), dup.source_domain].filter(Boolean)
  );
  const newDomain = article.source_domain || null;
  const independentSource = Boolean(newDomain && !knownDomains.has(newDomain));
  if (newDomain) knownDomains.add(newDomain);

  const update = {
    article_count: (dup.article_count || 1) + 1,
    confidence: mergeMacroConfidence(dup.confidence, row.confidence),
    updated_at: new Date().toISOString(),
    source_domains: [...knownDomains],
    ...(Number(row.source_score) > Number(dup.source_score ?? 0)
      ? { source_score: Number(row.source_score) }
      : {}),
  };
  // 未执行 015/016 迁移:逐列剥离缺失列重试(只缺 016 来源列时 015 的计数照常更新;
  // 全部可选列剥完仍失败才抛出,由上层 fail-open 照常插入)
  const applied = { ...update };
  for (const col of missingMacroColumns) delete applied[col];
  const db = supabase();
  let { error } = await db.from('macro_events').update(applied).eq('id', dup.id);
  while (error && /column|schema/i.test(error.message)) {
    const col = ['source_domains', 'source_score', 'article_count', 'updated_at'].find(
      (c) => c in applied && error.message.includes(c)
    );
    if (!col) break;
    if (OPTIONAL_MACRO_COLUMNS.includes(col)) missingMacroColumns.add(col);
    delete applied[col];
    ({ error } = await db.from('macro_events').update(applied).eq('id', dup.id));
  }
  if (error) throw new Error(error.message);
  if (independentSource && knownDomains.size >= 2) {
    console.log(`[macro] 事件 #${dup.id} 获得独立信源交叉佐证(${[...knownDomains].join(', ')})`);
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
