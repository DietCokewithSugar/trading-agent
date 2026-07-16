/**
 * 回测 AI 信号推导(032,纯函数):把逐文章的 LLM 分析结果(缓存行 ∪ 新分析)
 * 转成可交易的信号时间线。镜像实盘可交易门(newsService#runCycle 的 actionable 判定
 * + 综合置信度门),时效分钉死在发布时刻(=1.0);
 * 跨源确认与 LLM 事件链不重放,用确定性归并近似:同(执行日,方向)取综合置信度最高
 * 一条,同一执行日多空并存则双双丢弃(对应实盘 conflictResolver 的搁置语义)。
 */

import { computeFinalConfidence, isSelfIssued } from '../credibility.js';
import { isTradingDay, isEarlyClose } from '../marketCalendar.js';

const round3 = (n) => Math.round(n * 1000) / 1000;

const ET_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** ISO 时间 → 美东日历日与当日分钟数(DST 由 Intl 处理) */
export function etDateMinutes(iso) {
  if (!iso) return null; // new Date(null) 是 1970 epoch 而非 Invalid Date,必须显式拦
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const parts = ET_FMT.formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** 'YYYY-MM-DD' + n 天(纯日历运算,与时区无关) */
function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * 发布时刻 → 执行交易日:发布落在交易日且早于当日收盘(16:00,半日市 13:00)
 * → 当日收盘成交;否则顺延到下一交易日收盘。引擎里所有成交都发生在收盘,
 * 发布必然早于所属执行日的收盘 → 严格因果。
 */
export function executionDateOf(publishedAt) {
  const et = etDateMinutes(publishedAt);
  if (!et) return null;
  const closeMinutes = (dateStr) => (isEarlyClose(dateStr) ? 13 * 60 : 16 * 60);
  if (isTradingDay(et.date) && et.minutes < closeMinutes(et.date)) return et.date;
  let d = et.date;
  // 最多前探 10 个日历日,足够覆盖周末 + 长假
  for (let i = 0; i < 10; i++) {
    d = shiftDate(d, 1);
    if (isTradingDay(d)) return d;
  }
  return null;
}

/**
 * 分析行 → 信号时间线。
 * rows: [{ url, title, source, source_domain, source_score, publisher, published_at,
 *          relevant, analysis_symbol, sentiment, tier, confidence }]
 * 返回 { signals(按执行日升序), dropped(丢弃原因计数) }。
 */
export function deriveSignals(rows, { symbol, tradeTierThreshold, minFinalConfidence, pressBullishPenalty }) {
  const dropped = {
    irrelevant: 0,
    symbol_mismatch: 0,
    neutral: 0,
    low_tier: 0,
    low_confidence: 0,
    below_final_confidence: 0,
    no_execution_date: 0,
    merged: 0,
    conflict: 0,
  };
  const candidates = [];
  for (const row of rows || []) {
    if (row.relevant !== true) {
      dropped.irrelevant += 1;
      continue;
    }
    if (String(row.analysis_symbol || '').toUpperCase() !== String(symbol).toUpperCase()) {
      // 分析师认定的新闻主体不是查询标的(如把 SpaceX 新闻归到别的代码)—— 不用于本标的回放
      dropped.symbol_mismatch += 1;
      continue;
    }
    // 实盘 actionable 门(newsService):非中性、档位达标、原始置信度 ≥ 0.5(缺失即不达标)
    if (row.sentiment !== 'bullish' && row.sentiment !== 'bearish') {
      dropped.neutral += 1;
      continue;
    }
    if (!(Number(row.tier) >= 1) || Number(row.tier) > tradeTierThreshold) {
      dropped.low_tier += 1;
      continue;
    }
    const confidence = Number(row.confidence);
    if (!Number.isFinite(confidence) || confidence < 0.5) {
      dropped.low_confidence += 1;
      continue;
    }
    // 综合置信度门:时效锚定发布时刻(=1.0);利好且自述来源(新闻稿/监管披露)按实盘折价
    const publishMs = new Date(row.published_at || 0).getTime();
    const raw = computeFinalConfidence({
      sourceScore: row.source_score,
      confidence,
      publishedAt: row.published_at,
      tier: Number(row.tier),
      nowMs: Number.isFinite(publishMs) && publishMs > 0 ? publishMs : undefined,
    });
    const penalty =
      row.sentiment === 'bullish' &&
      isSelfIssued({ source: row.source, source_domain: row.source_domain, url: row.url })
        ? pressBullishPenalty
        : 1;
    const finalConfidence = round3(raw * penalty);
    if (finalConfidence < minFinalConfidence) {
      dropped.below_final_confidence += 1;
      continue;
    }
    const executionDate = executionDateOf(row.published_at);
    if (!executionDate) {
      dropped.no_execution_date += 1;
      continue;
    }
    candidates.push({
      execution_date: executionDate,
      published_at: row.published_at,
      direction: row.sentiment,
      tier: Number(row.tier),
      confidence,
      final_confidence: finalConfidence,
      url: row.url,
      title: row.title,
    });
  }

  // 确定性归并:同(执行日,方向)保留综合置信度最高的一条(近似实盘事件去重)
  const byDay = new Map(); // date -> { bullish?, bearish? }
  for (const c of candidates) {
    let day = byDay.get(c.execution_date);
    if (!day) {
      day = {};
      byDay.set(c.execution_date, day);
    }
    const cur = day[c.direction];
    if (!cur) day[c.direction] = c;
    else {
      dropped.merged += 1;
      if (c.final_confidence > cur.final_confidence) day[c.direction] = c;
    }
  }
  // 同一执行日多空并存 → 双双丢弃(实盘 conflictResolver 对势均信号的搁置语义)
  const signals = [];
  for (const [, day] of byDay) {
    if (day.bullish && day.bearish) {
      dropped.conflict += 2;
      continue;
    }
    signals.push(day.bullish || day.bearish);
  }
  signals.sort((a, b) => (a.execution_date < b.execution_date ? -1 : 1));
  return { signals, dropped };
}
