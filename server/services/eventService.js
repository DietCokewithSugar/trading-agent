import { supabase } from '../db.js';
import { config } from '../config.js';
import { matchEvent } from './deepseek.js';
import { extractDomain } from './credibility.js';

/**
 * 新闻事件溯源与去重。
 *
 * 同一个底层事件(同一份公告/合作/财报)经常被多家媒体以不同标题重复报道,
 * 如果每条报道都独立触发交易,就会对同一利好反复加仓。处理方式:
 *  1. 每个可交易信号先在 news_events 中做事件归并(DeepSeek 判断是否为既有事件的重复报道);
 *  2. 重复报道只累计计数,不再触发交易;只有真正的新事件才放行;
 *  3. 例外:事件尚未交易(如首发报道来源可信度不足被挂起)时,来自"独立信源"
 *     (此前未出现过的域名)的重复报道视为交叉确认,通过冷却期后以 confirmable
 *     返回,由上层用加成后的综合置信度重新评估是否放行;
 *  4. 新事件放行前再过一道同向交易冷却期,作为 LLM 误判的兜底;
 *  5. news_events 表不可用(迁移未执行)或归并失败时,退回纯冷却期判断,保证主流程不中断。
 *
 * 返回 { proceed, eventId, reason, confirmable?, distinctSources? }。
 */
export async function resolveEvent(article, analysisRow) {
  const db = supabase();
  const symbol = analysisRow.symbol;
  const summary = analysisRow.event_summary || article.title;
  const domain = extractDomain(article.url) || String(article.publisher || '').toLowerCase() || null;

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
        // 独立信源判定:仅在事件已记录过信源域名时才可能成立(009 迁移未执行时
        // source_domains 不存在,按约定 fail-closed,不做交叉确认)
        const knownDomains = Array.isArray(event.source_domains) ? event.source_domains : null;
        const isNewSource =
          Boolean(domain) && Array.isArray(knownDomains) && knownDomains.length > 0 && !knownDomains.includes(domain);
        const nextDomains = isNewSource ? [...knownDomains, domain] : knownDomains;

        const update = {
          article_count: (event.article_count || 1) + 1,
          updated_at: new Date().toISOString(),
        };
        if (isNewSource) update.source_domains = nextDomains;
        const { error: updErr } = await db.from('news_events').update(update).eq('id', event.id);
        if (updErr && /source_domains/.test(updErr.message)) {
          const { source_domains, ...legacy } = update;
          await db.from('news_events').update(legacy).eq('id', event.id);
        }
        await linkAnalysis(db, analysisRow.id, event.id);

        // 未交易事件 + 独立信源 = 交叉确认机会,仍需通过同向冷却期
        if (!event.traded && isNewSource) {
          const cooldown = await checkCooldown(db, analysisRow);
          if (cooldown.ok) {
            return {
              proceed: false,
              confirmable: true,
              eventId: event.id,
              distinctSources: nextDomains.length,
              reason: `独立信源交叉确认(事件 #${event.id}:${event.summary},第 ${update.article_count} 篇报道,信源 ${nextDomains.length} 个)`,
            };
          }
        }
        return {
          proceed: false,
          eventId: event.id,
          reason: `同一事件的重复报道(事件 #${event.id}:${event.summary});${match.reason}`,
        };
      }
    }

    const row = {
      symbol,
      sentiment: analysisRow.sentiment,
      summary,
      first_news_id: article.id,
      source_domains: domain ? [domain] : [],
    };
    let { data: created, error: insErr } = await db.from('news_events').insert(row).select().single();
    // 兼容尚未执行 009 迁移的数据库:去掉 source_domains 列重试
    if (insErr && /source_domains/.test(insErr.message)) {
      const { source_domains, ...legacy } = row;
      ({ data: created, error: insErr } = await db.from('news_events').insert(legacy).select().single());
    }
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

/**
 * 同一股票同方向的新闻交易冷却复查(分配器在执行候选前调用:
 * 上一轮刚成交的同票候选,本轮不能再买)。symbol+side 直接给定。
 */
export async function checkTradeCooldown(symbol, side) {
  return checkCooldown(supabase(), {
    symbol,
    sentiment: side === 'buy' ? 'bullish' : 'bearish',
  });
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

    // 开盘队列里同向的待成交挂单也算占用冷却期(挂单成交前不会出现在 trades 表里,
    // 不查会导致休市期间同一股票的多个事件各挂一单);010 迁移未执行时跳过该检查
    const { data: pending, error: pendErr } = await db
      .from('pending_orders')
      .select('id')
      .eq('symbol', analysisRow.symbol)
      .eq('side', side)
      .eq('status', 'pending')
      .limit(1);
    if (!pendErr && pending?.length) {
      return {
        ok: false,
        reason: `开盘队列中已有同向挂单(#${pending[0].id})`,
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
