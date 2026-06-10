import { supabase } from '../db.js';
import { config } from '../config.js';
import { matchEvent } from './deepseek.js';

/**
 * 新闻事件溯源与去重。
 *
 * 同一个底层事件(同一份公告/合作/财报)经常被多家媒体以不同标题重复报道,
 * 如果每条报道都独立触发交易,就会对同一利好反复加仓。处理方式:
 *  1. 每个可交易信号先在 news_events 中做事件归并(DeepSeek 判断是否为既有事件的重复报道);
 *  2. 重复报道只累计计数,不再触发交易;只有真正的新事件才放行;
 *  3. 新事件放行前再过一道同向交易冷却期,作为 LLM 误判的兜底;
 *  4. news_events 表不可用(迁移未执行)或归并失败时,退回纯冷却期判断,保证主流程不中断。
 *
 * 返回 { proceed, eventId, reason }。
 */
export async function resolveEvent(article, analysisRow) {
  const db = supabase();
  const symbol = analysisRow.symbol;
  const summary = analysisRow.event_summary || article.title;

  let eventId = null;
  try {
    const since = new Date(Date.now() - config.eventDedupHours * 3600_000).toISOString();
    const { data: events, error } = await db
      .from('news_events')
      .select('*')
      .eq('symbol', symbol)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);

    if (events?.length) {
      const match = await matchEvent({
        symbol,
        eventSummary: summary,
        articleTitle: article.title,
        recentEvents: events,
      });
      const event = match.duplicateOf ? events.find((e) => e.id === match.duplicateOf) : null;
      if (event) {
        await db
          .from('news_events')
          .update({
            article_count: (event.article_count || 1) + 1,
            updated_at: new Date().toISOString(),
          })
          .eq('id', event.id);
        await linkAnalysis(db, analysisRow.id, event.id);
        return {
          proceed: false,
          eventId: event.id,
          reason: `同一事件的重复报道(事件 #${event.id}:${event.summary});${match.reason}`,
        };
      }
    }

    const { data: created, error: insErr } = await db
      .from('news_events')
      .insert({
        symbol,
        sentiment: analysisRow.sentiment,
        summary,
        first_news_id: article.id,
      })
      .select()
      .single();
    if (insErr) throw new Error(insErr.message);
    eventId = created.id;
    await linkAnalysis(db, analysisRow.id, eventId);
  } catch (err) {
    console.warn(`[event] ${symbol} 事件归并不可用(${err.message}),退回冷却期判断`);
  }

  // 新事件(或归并不可用)仍需通过同向交易冷却期才放行
  const cooldown = await checkCooldown(db, analysisRow);
  if (!cooldown.ok) {
    return { proceed: false, eventId, reason: cooldown.reason };
  }
  return { proceed: true, eventId, reason: '新事件,放行' };
}

async function linkAnalysis(db, analysisId, eventId) {
  const { error } = await db
    .from('news_analyses')
    .update({ event_id: eventId })
    .eq('id', analysisId);
  if (error) console.warn(`[event] 关联分析 ${analysisId} → 事件 ${eventId} 失败: ${error.message}`);
}

/** 同一股票同方向的新闻交易,冷却期内不再重复触发 */
async function checkCooldown(db, analysisRow) {
  try {
    const side = analysisRow.sentiment === 'bullish' ? 'buy' : 'sell';
    const since = new Date(Date.now() - config.tradeCooldownMinutes * 60_000).toISOString();
    const { data, error } = await db
      .from('trades')
      .select('id, created_at')
      .eq('symbol', analysisRow.symbol)
      .eq('side', side)
      .eq('trigger', 'news')
      .gte('created_at', since)
      .limit(1);
    if (error) throw new Error(error.message);
    if (data?.length) {
      return {
        ok: false,
        reason: `冷却期内已有同向新闻交易(${config.tradeCooldownMinutes} 分钟内,交易 #${data[0].id})`,
      };
    }
    return { ok: true };
  } catch (err) {
    // 去重防线全部失效时保守跳过,宁可错过也不重复下单
    console.warn(`[event] 冷却期判断失败(${err.message}),保守跳过本次交易`);
    return { ok: false, reason: '去重检查不可用,保守跳过' };
  }
}

/** 交易成功后把事件标记为已交易,后续重复报道不再触发 */
export async function markEventTraded(eventId, tradeId) {
  if (!eventId) return;
  const { error } = await supabase()
    .from('news_events')
    .update({ traded: true, trade_id: tradeId, updated_at: new Date().toISOString() })
    .eq('id', eventId);
  if (error) console.warn(`[event] 标记事件 ${eventId} 已交易失败: ${error.message}`);
}
