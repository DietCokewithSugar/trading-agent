import { XMLParser } from 'fast-xml-parser';
import { config } from '../config.js';
import { getMarketSession } from './fmp.js';
import { normalizeDirectorySymbol } from './symbolReference.js';

/**
 * 停牌守护(028,日志前缀 [halts],ENABLE_HALT_GUARD)。
 *
 * 盘中轮询交易所官方 Trading Halts RSS(全市场,含 T1 新闻待发/LUDP 波动熔断/
 * H10 监管停牌等),维护进程内"生效中停牌"集合,同步查询 isSymbolHalted() 可进交易锁:
 * - 新买入:settleBuyLocked 处 transient reject(候选留池/挂单保留,复牌自动重试);
 * - 持仓:riskMonitor/shadow 跳过停牌票的止损/止盈/持有超时(停牌期间报价是
 *   停牌前最后一笔,按 stale price 强平不真实);
 * - 新闻利空卖单:挂入开盘队列,复牌后按真实价成交。
 *
 * fail-open 设计(与 marketCheck 同款):功能关闭/未就绪/数据陈旧(超过
 * 3×轮询间隔+60s)一律返回"未停牌"——守护退化为没有该功能时的现状,
 * 绝不因 feed 故障按幽灵停牌拦单。重启期间的停牌由首轮 poll 恢复
 * (feed 会列出仍未复牌的历史停牌);跨多日停牌滚出 feed 的极端情况
 * 同样 fail-open,由复牌后的止损/持有超时兜底。管理重置不清(外部市场数据)。
 */

const HALTS_RSS_URL = 'https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts';

// RSS item 字段带 ndaq: 命名空间前缀,removeNSPrefix 统一去掉
const rssParser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true });

// ── 纯函数(可单测,无 IO)──

/** 美东 "MM/DD/YYYY" + "HH:MM:SS" → UTC Date(EST/EDT 偏移试探,DST 安全);非法返回 null */
export function etDateTimeToUtc(dateStr, timeStr) {
  const dm = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(dateStr ?? '').trim());
  const tm = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(timeStr ?? '').trim());
  if (!dm || !tm) return null;
  const [, mo, dd, yyyy] = dm;
  const hhmmss = `${tm[1]}:${tm[2]}:${tm[3] ?? '00'}`;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  for (const offset of ['-05:00', '-04:00']) {
    const candidate = new Date(`${yyyy}-${mo}-${dd}T${hhmmss}${offset}`);
    if (Number.isNaN(candidate.getTime())) continue;
    const p = Object.fromEntries(fmt.formatToParts(candidate).map((x) => [x.type, x.value]));
    if (
      `${p.year}-${p.month}-${p.day}` === `${yyyy}-${mo}-${dd}` &&
      `${p.hour}:${p.minute}` === `${tm[1]}:${tm[2]}`
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Trading Halts RSS → 条目数组。字段(去命名空间后):IssueSymbol / ReasonCode /
 * HaltDate / HaltTime / ResumptionDate / ResumptionQuoteTime / ResumptionTradeTime。
 */
export function parseHaltsRss(xml) {
  let doc;
  try {
    doc = rssParser.parse(String(xml ?? ''));
  } catch {
    return [];
  }
  let items = doc?.rss?.channel?.item ?? [];
  if (!Array.isArray(items)) items = [items];
  const out = [];
  for (const it of items) {
    if (!it) continue;
    const symbol = normalizeDirectorySymbol(it.IssueSymbol);
    if (!symbol) continue;
    const str = (v) => {
      const s = String(v ?? '').trim();
      return s || null;
    };
    out.push({
      symbol,
      reasonCode: str(it.ReasonCode),
      haltDate: str(it.HaltDate),
      haltTime: str(it.HaltTime),
      resumptionDate: str(it.ResumptionDate),
      resumptionQuoteTime: str(it.ResumptionQuoteTime),
      resumptionTradeTime: str(it.ResumptionTradeTime),
    });
  }
  return out;
}

/** 停牌是否仍生效:无恢复交易时间 → 生效;可解析且已过 → 已复牌;将来 → 仍生效 */
export function isHaltActive(item, now = new Date()) {
  if (!item?.resumptionTradeTime) return true;
  const resume = etDateTimeToUtc(item.resumptionDate ?? item.haltDate, item.resumptionTradeTime);
  if (!resume) return true; // 恢复时间存在但解析失败:保守视为仍停牌
  return resume.getTime() > now.getTime();
}

/** 条目数组 → 生效中停牌 Map<symbol, item>(同符号取最新一次停牌的条目) */
export function buildActiveHaltMap(items, now = new Date()) {
  const map = new Map();
  const haltAt = (it) => etDateTimeToUtc(it.haltDate, it.haltTime)?.getTime() ?? 0;
  for (const it of items || []) {
    if (!it?.symbol) continue;
    const prev = map.get(it.symbol);
    if (!prev || haltAt(it) >= haltAt(prev.item)) {
      map.set(it.symbol, { item: it, active: isHaltActive(it, now) });
    }
  }
  const active = new Map();
  for (const [symbol, { item, active: isActive }] of map) {
    if (isActive) active.set(symbol, item);
  }
  return active;
}

// ── IO/状态层 ──

const haltState = {
  active: new Map(),
  fetchedAt: null,
  available: false,
};
let fetchFailedWarned = false;
let polling = false;

/** 调度器周期调用:休市时段跳过(feed 覆盖当日,休市中无法交易也无需守护) */
export async function pollTradingHalts() {
  if (!config.enableHaltGuard || polling) return;
  if (getMarketSession() === 'closed') return;
  polling = true;
  try {
    const res = await fetch(HALTS_RSS_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`停牌 feed ${res.status}`);
    const items = parseHaltsRss(await res.text());
    const prevCount = haltState.active.size;
    haltState.active = buildActiveHaltMap(items);
    haltState.fetchedAt = Date.now();
    haltState.available = true;
    if (fetchFailedWarned) {
      fetchFailedWarned = false;
      console.log('[halts] 停牌 feed 恢复');
    }
    if (haltState.active.size !== prevCount) {
      console.log(`[halts] 生效中停牌 ${haltState.active.size} 只`);
    }
  } catch (err) {
    // 保留旧状态;陈旧超限后 isSymbolHalted 自动 fail-open
    if (!fetchFailedWarned) {
      fetchFailedWarned = true;
      console.warn(`[halts] 停牌 feed 拉取失败(沿用旧状态,陈旧超限自动放行): ${err.message}`);
    }
  } finally {
    polling = false;
  }
}

/** 数据是否仍然新鲜:3×轮询间隔 + 60s 内 */
function isFresh() {
  if (!haltState.fetchedAt) return false;
  const maxAgeMs = 3 * Math.max(config.haltPollSeconds, 30) * 1000 + 60_000;
  return Date.now() - haltState.fetchedAt < maxAgeMs;
}

/**
 * 同步停牌查询(可进交易锁)。fail-open:功能关闭/未就绪/数据陈旧一律 false。
 * 例外:休市时段数据必然"陈旧"(轮询暂停),但休市中所有交易本就不执行,
 * 该窗口的返回值无消费方,无需特判。
 */
export function isSymbolHalted(symbol) {
  if (!config.enableHaltGuard || !isFresh()) return false;
  const key = normalizeDirectorySymbol(symbol);
  return Boolean(key && haltState.active.has(key));
}

/** 状态载荷(公开面只取 activeCount/fetchedAt;完整列表进 token 门控管理面) */
export function getHaltState() {
  return {
    enabled: config.enableHaltGuard,
    available: haltState.available && isFresh(),
    activeCount: haltState.active.size,
    fetchedAt: haltState.fetchedAt ? new Date(haltState.fetchedAt).toISOString() : null,
    halts: [...haltState.active.values()].map((it) => ({
      symbol: it.symbol,
      reason_code: it.reasonCode,
      halted_at: `${it.haltDate ?? ''} ${it.haltTime ?? ''}`.trim() || null,
    })),
  };
}
