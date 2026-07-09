import { config } from '../config.js';
import { supabase } from '../db.js';
import { mapOtherExchangeCode } from './eligibility.js';

/**
 * 标的名录(028,日志前缀 [symref],ENABLE_SYMBOL_REFERENCE)。
 *
 * 从交易所官方符号目录(纳斯达克交易平台每日/盘中更新的
 * nasdaqlisted.txt + otherlisted.txt,管道分隔,尾行 File Creation Time)
 * 构建全市场上市名录:存在性(OTC/退市识别)、ETF 标记、测试标的、
 * 财务异常状态(退市风险/破产)、上市交易所——比行情商 profile 更权威,
 * 供准入门(eligibility.js#checkBuyEligibility 的 reference 参数)做确定性校验。
 *
 * 进程内 Map 是主数据(同步查询,可进交易锁);symbol_reference 表是
 * 重启暖表与审计镜像——表缺失(未跑 027)只停镜像,名录照常工作。
 * 换表守卫:双文件都解析成功(含尾行完整性)且行数不低于下限才原子换表,
 * 残缺下载绝不覆盖旧名录。管理重置不清(外部市场数据,经济日历/CIK 映射同款先例)。
 */

const NASDAQ_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt';
const OTHER_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt';
// 换表守卫的行数下限:正常文件分别约 5000/6000 行,低于下限视为残缺
const MIN_NASDAQ_ROWS = 3000;
const MIN_OTHER_ROWS = 2000;

// ── 纯函数(可单测,无 IO)──

/** 符号归一:大写 trim,'.'→'-'(BRK.A → BRK-A,与报价源/CIK 映射口径一致);空返回 null */
export function normalizeDirectorySymbol(raw) {
  const s = String(raw ?? '').trim().toUpperCase().replace(/\./g, '-');
  return s || null;
}

/**
 * 管道分隔目录文件 → { rows, creationTime }。
 * 首行是表头(跳过),尾行 "File Creation Time: ..." 是完整性标志——
 * 缺失即视为下载不完整,返回 null(调用方绝不用残缺文件换表)。
 */
export function splitPipeDirectory(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const trailer = lines[lines.length - 1];
  const tm = /^File Creation Time:\s*([^|]*)/i.exec(trailer);
  if (!tm) return null;
  const rows = lines.slice(1, -1).map((l) => l.split('|'));
  return { rows, creationTime: tm[1].trim() || null };
}

const yes = (v) => String(v ?? '').trim().toUpperCase() === 'Y';

/**
 * nasdaqlisted.txt(Symbol|Security Name|Market Category|Test Issue|Financial Status|
 * Round Lot Size|ETF|NextShares)→ { entries, creationTime } | null。
 */
export function parseNasdaqListed(text) {
  const parsed = splitPipeDirectory(text);
  if (!parsed) return null;
  const entries = [];
  for (const cols of parsed.rows) {
    const symbol = normalizeDirectorySymbol(cols[0]);
    if (!symbol || cols.length < 7) continue;
    entries.push({
      symbol,
      securityName: String(cols[1] ?? '').trim() || null,
      marketCategory: String(cols[2] ?? '').trim() || null,
      isTestIssue: yes(cols[3]),
      financialStatus: String(cols[4] ?? '').trim() || null,
      roundLot: Number(cols[5]) || null,
      isEtf: yes(cols[6]),
      exchange: 'NASDAQ',
      listingSource: 'nasdaq',
    });
  }
  return { entries, creationTime: parsed.creationTime };
}

/**
 * otherlisted.txt(ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|
 * Test Issue|NASDAQ Symbol)→ { entries, creationTime } | null。
 * 交易所单字母代码经 mapOtherExchangeCode 归一;无财务状态字段(仅 NASDAQ 上市有)。
 */
export function parseOtherListed(text) {
  const parsed = splitPipeDirectory(text);
  if (!parsed) return null;
  const entries = [];
  for (const cols of parsed.rows) {
    const symbol = normalizeDirectorySymbol(cols[0]);
    if (!symbol || cols.length < 7) continue;
    entries.push({
      symbol,
      securityName: String(cols[1] ?? '').trim() || null,
      marketCategory: null,
      isTestIssue: yes(cols[6]),
      financialStatus: null,
      roundLot: Number(cols[5]) || null,
      isEtf: yes(cols[4]),
      exchange: mapOtherExchangeCode(cols[2]),
      listingSource: 'other',
    });
  }
  return { entries, creationTime: parsed.creationTime };
}

/**
 * 两文件条目合并为 Map<symbol, entry>。同符号冲突 nasdaq 目录优先(理论不应发生);
 * 测试标的保留并打 isTestIssue 标记(准入门给出"测试标的"的精确拒绝理由,
 * 而不是误报"名录外")。
 */
export function buildReferenceMap(nasdaqEntries, otherEntries) {
  const map = new Map();
  for (const e of otherEntries || []) {
    if (e?.symbol) map.set(e.symbol, e);
  }
  for (const e of nasdaqEntries || []) {
    if (e?.symbol) map.set(e.symbol, e);
  }
  return map;
}

// ── IO 层 ──

// 进程内名录状态:refState.map 为主数据;source 标注来源(fresh=刚抓的/db=启动暖表)
const refState = {
  map: null,
  loaded: false,
  refreshedAt: null,
  source: null,
  creationTimes: null,
};
let mirrorTableMissing = false;
let refreshing = false;

async function fetchDirectory(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`目录下载失败 ${res.status}: ${url.slice(0, 80)}`);
  return res.text();
}

function isMissingTable(error) {
  return /symbol_reference/.test(error?.message || '') &&
    /not find|does not exist|schema cache|PGRST205/i.test(error?.message || '');
}

/** 名录镜像落库:分批 upsert + 清理本轮未出现的退市行(best-effort,失败只 warn) */
async function mirrorToDb(map, refreshStartIso) {
  if (mirrorTableMissing) return;
  try {
    const rows = [...map.values()].map((e) => ({
      symbol: e.symbol,
      security_name: e.securityName,
      exchange: e.exchange,
      market_category: e.marketCategory,
      is_etf: e.isEtf,
      is_test_issue: e.isTestIssue,
      financial_status: e.financialStatus,
      round_lot: e.roundLot,
      listing_source: e.listingSource,
      updated_at: new Date().toISOString(),
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase()
        .from('symbol_reference')
        .upsert(rows.slice(i, i + 500), { onConflict: 'symbol' });
      if (error) throw new Error(error.message);
    }
    // 本轮快照里没有的符号 = 已退市/改码,从镜像清理
    const { error: delError } = await supabase()
      .from('symbol_reference')
      .delete()
      .lt('updated_at', refreshStartIso);
    if (delError) throw new Error(delError.message);
  } catch (err) {
    if (isMissingTable(err)) {
      if (!mirrorTableMissing) {
        mirrorTableMissing = true;
        console.warn('[symref] symbol_reference 表不可用(请执行 028 迁移),名录镜像停用,进程内名录不受影响');
      }
      return;
    }
    console.warn(`[symref] 名录镜像落库失败(进程内名录不受影响): ${err.message}`);
  }
}

/** 调度器周期调用:抓官方目录 → 换表守卫 → 原子换进程内 Map → 镜像落库 */
export async function refreshSymbolReference() {
  if (refreshing) return;
  refreshing = true;
  try {
    const refreshStartIso = new Date().toISOString();
    const [nasdaqText, otherText] = await Promise.all([
      fetchDirectory(NASDAQ_LISTED_URL),
      fetchDirectory(OTHER_LISTED_URL),
    ]);
    const nasdaq = parseNasdaqListed(nasdaqText);
    const other = parseOtherListed(otherText);
    // 换表守卫:任一文件残缺(无尾行)或行数异常少 → 沿用旧名录
    if (!nasdaq || !other || nasdaq.entries.length < MIN_NASDAQ_ROWS || other.entries.length < MIN_OTHER_ROWS) {
      console.warn(
        `[symref] 目录文件不完整(nasdaq ${nasdaq?.entries.length ?? '解析失败'} 行 / other ${other?.entries.length ?? '解析失败'} 行),沿用旧名录`
      );
      return;
    }
    const map = buildReferenceMap(nasdaq.entries, other.entries);
    refState.map = map;
    refState.loaded = true;
    refState.refreshedAt = refreshStartIso;
    refState.source = 'fresh';
    refState.creationTimes = { nasdaq: nasdaq.creationTime, other: other.creationTime };
    console.log(`[symref] 名录刷新完成:${map.size} 只(nasdaq ${nasdaq.entries.length} / other ${other.entries.length})`);
    await mirrorToDb(map, refreshStartIso);
  } catch (err) {
    console.warn(`[symref] 名录刷新失败(沿用旧名录): ${err.message}`);
  } finally {
    refreshing = false;
  }
}

/** 启动预热:先从 DB 镜像暖表(快、离线可用),再异步抓最新目录 */
export async function warmSymbolReference() {
  try {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase()
        .from('symbol_reference')
        .select('*')
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    if (rows.length) {
      const map = new Map();
      for (const r of rows) {
        map.set(r.symbol, {
          symbol: r.symbol,
          securityName: r.security_name,
          exchange: r.exchange,
          marketCategory: r.market_category,
          isEtf: r.is_etf,
          isTestIssue: r.is_test_issue,
          financialStatus: r.financial_status,
          roundLot: r.round_lot,
          listingSource: r.listing_source,
        });
      }
      refState.map = map;
      refState.loaded = true;
      refState.source = 'db';
      console.log(`[symref] 名录从镜像暖表 ${map.size} 只,随即刷新`);
    }
  } catch (err) {
    if (isMissingTable(err)) {
      mirrorTableMissing = true;
      console.warn('[symref] symbol_reference 表不可用(请执行 028 迁移),跳过暖表');
    } else {
      console.warn(`[symref] 名录暖表失败(等待首轮刷新): ${err.message}`);
    }
  }
  // 暖表与否都立即刷新一次,失败由周期循环兜底
  await refreshSymbolReference();
}

/**
 * 准入门同步查询:{ loaded, entry }。
 * 功能关闭/名录未就绪 → loaded:false(准入门整组跳过名录检查,可加性设计);
 * loaded 且 entry 为 null = 名录里没有(疑似 OTC/已退市)。
 */
export function getReferenceForEligibility(symbol) {
  if (!config.enableSymbolReference || !refState.loaded || !refState.map) {
    return { loaded: false, entry: null };
  }
  const key = normalizeDirectorySymbol(symbol);
  return { loaded: true, entry: (key && refState.map.get(key)) || null };
}

/** 管理面状态 */
export function getSymbolReferenceStatus() {
  return {
    enabled: config.enableSymbolReference,
    loaded: refState.loaded,
    count: refState.map ? refState.map.size : 0,
    refreshed_at: refState.refreshedAt,
    source: refState.source,
    creation_times: refState.creationTimes,
    mirror_available: !mirrorTableMissing,
  };
}
