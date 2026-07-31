/**
 * 指数估值(估值看板 033 的外部数据源,蛋卷指数估值公开 JSON):
 * 标普500 / 纳指100 的 TTM PE 与历史分位。观察层 fail-open:失败回退 48h 内旧值,
 * 超龄返回 null(PE 卡「暂无数据」);两指数独立降级(接口缺纳指行时标普照常)。
 * 公开载荷/UI 不出现供应商名(约定见 CLAUDE.md);分位窗口以接口口径为准,
 * UI 标「历史分位」而非硬称「近5年」。
 */
import { config } from '../config.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15_000;
const FRESH_MS = 6 * 3600_000;
const STALE_MAX_MS = 48 * 3600_000;
const WARN_INTERVAL_MS = 30 * 60_000;

const state = {
  data: null, // { ndx: {pe, pe_pct}|null, spx: {pe, pe_pct}|null, fetched_at }
  fetchedAt: 0,
  inflight: null,
  lastWarnAt: 0,
};

function warnLimited(msg) {
  if (Date.now() - state.lastWarnAt < WARN_INTERVAL_MS) return;
  state.lastWarnAt = Date.now();
  console.warn(`[valuation] 指数估值抓取失败(PE 卡按旧值/暂无数据降级): ${msg}`);
}

/** 分位归一:接口给 0–1 小数则换算为 0–100 百分数 */
function normalizePct(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  const pct = n <= 1 ? n * 100 : n;
  return pct <= 100 ? Math.round(pct * 10) / 10 : null;
}

/** 代码精确匹配优先,名称包含匹配兜底(接口的 index_code 口径可能调整) */
function matchItem(items, codes, nameKeys) {
  return (
    items.find((it) => codes.includes(String(it?.index_code || '').toUpperCase())) ||
    items.find((it) => nameKeys.some((k) => String(it?.name || '').includes(k))) ||
    null
  );
}

function toEntry(item) {
  if (!item) return null;
  const pe = Number(item.pe);
  const pePct = normalizePct(item.pe_percentile);
  if (!Number.isFinite(pe) && pePct === null) return null;
  return {
    pe: Number.isFinite(pe) ? Math.round(pe * 100) / 100 : null,
    pe_pct: pePct,
  };
}

async function fetchOnce() {
  const res = await fetch(config.indexValuationUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`估值源响应 ${res.status}`);
  const body = await res.json();
  // 解析口径:{ data: { items: [{ index_code, name, pe, pe_percentile }] } }
  const items = body?.data?.items ?? body?.items;
  if (!Array.isArray(items) || !items.length) throw new Error('估值源返回结构不符');
  const spx = toEntry(matchItem(items, ['SP500', 'SPX', '.INX'], ['标普500', '标普 500']));
  const ndx = toEntry(
    matchItem(items, ['NDX', 'NDX100', 'NASDAQ100', 'NDAQ100'], ['纳斯达克100', '纳斯达克 100', '纳指100'])
  );
  if (!spx && !ndx) throw new Error('估值源未含标普/纳指条目');
  return { spx, ndx, fetched_at: new Date().toISOString() };
}

/**
 * 当前指数估值:{ spx, ndx, fetched_at } | null(spx/ndx 各自可能为 null)。
 * 缓存/回退语义与情绪源一致。
 */
export async function getIndexValuation() {
  const age = Date.now() - state.fetchedAt;
  if (state.data && age < FRESH_MS) return state.data;
  if (!state.inflight) {
    state.inflight = fetchOnce()
      .then((data) => {
        state.data = data;
        state.fetchedAt = Date.now();
        return data;
      })
      .catch((err) => {
        warnLimited(err.message);
        return null;
      })
      .finally(() => {
        state.inflight = null;
      });
  }
  const fresh = await state.inflight;
  if (fresh) return fresh;
  if (state.data && Date.now() - state.fetchedAt < STALE_MAX_MS) return state.data;
  return null;
}

/** 测试/重置用:清空进程内缓存 */
export function clearIndexValuationCache() {
  state.data = null;
  state.fetchedAt = 0;
  state.inflight = null;
  state.lastWarnAt = 0;
}
