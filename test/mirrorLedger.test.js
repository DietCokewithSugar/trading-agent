import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRealizedFromFills, fillsToTrades } from '../server/services/mirrorLedger.js';

function fill(id, side, symbol, qty, price, at, extra = {}) {
  return {
    id,
    side,
    symbol,
    filled_qty: qty,
    filled_avg_price: price,
    filled_at: at,
    submitted_at: at,
    ...extra,
  };
}

test('computeRealizedFromFills:多笔买入加权均价后卖出', () => {
  // 10 股 @100 + 10 股 @110 → 均价 105;卖 20 股 @108 → (108-105)×20 = 60
  const { realizedById, totals } = computeRealizedFromFills([
    fill(1, 'buy', 'AAPL', 10, 100, '2026-07-01T14:00:00Z'),
    fill(2, 'buy', 'AAPL', 10, 110, '2026-07-01T15:00:00Z'),
    fill(3, 'sell', 'AAPL', 20, 108, '2026-07-02T14:00:00Z'),
  ]);
  assert.equal(realizedById.get(3), 60);
  assert.deepEqual(totals, { realized_pnl: 60, sell_count: 1, win_count: 1 });
});

test('computeRealizedFromFills:分次部分卖出各自计盈亏', () => {
  const { realizedById, totals } = computeRealizedFromFills([
    fill(1, 'buy', 'MSFT', 10, 200, '2026-07-01T14:00:00Z'),
    fill(2, 'sell', 'MSFT', 4, 210, '2026-07-01T16:00:00Z'), // +40
    fill(3, 'sell', 'MSFT', 6, 190, '2026-07-02T14:00:00Z'), // -60
  ]);
  assert.equal(realizedById.get(2), 40);
  assert.equal(realizedById.get(3), -60);
  assert.deepEqual(totals, { realized_pnl: -20, sell_count: 2, win_count: 1 });
});

test('computeRealizedFromFills:部分成交按 filled_qty 计,零成交行剔除', () => {
  const { realizedById, totals } = computeRealizedFromFills([
    fill(1, 'buy', 'NVDA', 3, 100, '2026-07-01T14:00:00Z', { qty: 10 }), // 挂 10 成 3
    fill(2, 'sell', 'NVDA', 0, 105, '2026-07-01T15:00:00Z', { qty: 10 }), // 零成交
    fill(3, 'sell', 'NVDA', 3, 105, '2026-07-01T16:00:00Z', { qty: 10 }),
  ]);
  assert.equal(realizedById.has(2), false);
  assert.equal(realizedById.get(3), 15);
  assert.equal(totals.sell_count, 1);
});

test('computeRealizedFromFills:零持仓卖出 realized=null 且不计胜率', () => {
  // 对账/清仓单场景:券商侧有仓但镜像成交序列里没有买入
  const { realizedById, totals } = computeRealizedFromFills([
    fill(1, 'sell', 'TSLA', 5, 300, '2026-07-01T14:00:00Z'),
  ]);
  assert.equal(realizedById.get(1), null);
  assert.deepEqual(totals, { realized_pnl: 0, sell_count: 0, win_count: 0 });
});

test('computeRealizedFromFills:超量卖出只对在册部分计盈亏', () => {
  const { realizedById, totals } = computeRealizedFromFills([
    fill(1, 'buy', 'AMD', 5, 100, '2026-07-01T14:00:00Z'),
    fill(2, 'sell', 'AMD', 8, 110, '2026-07-01T16:00:00Z'), // 只有 5 股在册 → +50
  ]);
  assert.equal(realizedById.get(2), 50);
  assert.deepEqual(totals, { realized_pnl: 50, sell_count: 1, win_count: 1 });
});

test('computeRealizedFromFills:清仓后重建仓不带旧均价', () => {
  const { realizedById } = computeRealizedFromFills([
    fill(1, 'buy', 'META', 10, 100, '2026-07-01T14:00:00Z'),
    fill(2, 'sell', 'META', 10, 120, '2026-07-01T16:00:00Z'), // +200,清仓
    fill(3, 'buy', 'META', 10, 150, '2026-07-02T14:00:00Z'),
    fill(4, 'sell', 'META', 10, 160, '2026-07-02T16:00:00Z'), // 新均价 150 → +100
  ]);
  assert.equal(realizedById.get(2), 200);
  assert.equal(realizedById.get(4), 100);
});

test('computeRealizedFromFills:多 symbol 交叉独立、重试链子单是独立成交', () => {
  const { realizedById, totals } = computeRealizedFromFills([
    fill(1, 'buy', 'AAPL', 10, 100, '2026-07-01T14:00:00Z'),
    fill(2, 'buy', 'MSFT', 10, 200, '2026-07-01T14:10:00Z'),
    // 同一笔内部卖出的重试链:原单成交 6 股,子单(retry_of=3)补 4 股
    fill(3, 'sell', 'AAPL', 6, 110, '2026-07-01T15:00:00Z'),
    fill(4, 'sell', 'AAPL', 4, 112, '2026-07-01T15:20:00Z', { retry_of: 3, attempt: 2 }),
    fill(5, 'sell', 'MSFT', 10, 190, '2026-07-01T16:00:00Z'),
  ]);
  assert.equal(realizedById.get(3), 60); // (110-100)×6
  assert.equal(realizedById.get(4), 48); // (112-100)×4
  assert.equal(realizedById.get(5), -100);
  assert.equal(totals.realized_pnl, 8);
  assert.deepEqual([totals.sell_count, totals.win_count], [3, 2]);
});

test('computeRealizedFromFills:filled_at 缺失退回 submitted_at 排序', () => {
  // 卖出行 filled_at 为 null,但 submitted_at 晚于买入 → 仍按先买后卖重放
  const { realizedById } = computeRealizedFromFills([
    { id: 2, side: 'sell', symbol: 'NFLX', filled_qty: 5, filled_avg_price: 110, filled_at: null, submitted_at: '2026-07-01T16:00:00Z' },
    fill(1, 'buy', 'NFLX', 5, 100, '2026-07-01T14:00:00Z'),
  ]);
  assert.equal(realizedById.get(2), 50);
});

test('computeRealizedFromFills:逐笔求和与 totals 一致', () => {
  const fills = [
    fill(1, 'buy', 'A', 10, 10, '2026-07-01T14:00:00Z'),
    fill(2, 'sell', 'A', 4, 12, '2026-07-01T15:00:00Z'),
    fill(3, 'sell', 'A', 6, 9, '2026-07-01T16:00:00Z'),
    fill(4, 'sell', 'B', 3, 5, '2026-07-01T17:00:00Z'), // 无持仓 → null,不入合计
  ];
  const { realizedById, totals } = computeRealizedFromFills(fills);
  const sum = [...realizedById.values()].filter((v) => v !== null).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(sum * 100) / 100, totals.realized_pnl);
});

test('fillsToTrades:字段映射/id 命名空间/时间倒序', () => {
  const rows = fillsToTrades([
    fill(1, 'buy', 'AAPL', 2, 100.005, '2026-07-01T14:00:00Z'),
    fill(2, 'sell', 'AAPL', 2, 110, '2026-07-01T16:00:00Z'),
  ], { realizedById: new Map([[2, 19.99]]) });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'bm-2'); // 倒序:卖出在前
  assert.equal(rows[0].realized_pnl, 19.99);
  assert.equal(rows[0].ledger, 'broker');
  const buy = rows[1];
  assert.deepEqual(
    [buy.id, buy.side, buy.symbol, buy.quantity, buy.price, buy.amount, buy.realized_pnl],
    ['bm-1', 'buy', 'AAPL', 2, 100.005, 200.01, null]
  );
});

test('fillsToTrades:meta 按 trade_id 关联,对账单(无 trade_id)meta 全空', () => {
  const meta = new Map([
    [77, { trigger: 'news', reason: '利好', macro_regime: 'neutral', news_articles: { title: 't', url: 'u' }, news_analyses: { sentiment: 'bullish', tier: 1 } }],
  ]);
  const rows = fillsToTrades([
    fill(1, 'buy', 'AAPL', 1, 100, '2026-07-01T14:00:00Z', { trade_id: 77 }),
    fill(2, 'sell', 'AAPL', 1, 90, '2026-07-01T15:00:00Z', { trade_id: null }),
  ], { metaById: meta });
  const linked = rows.find((r) => r.id === 'bm-1');
  const orphan = rows.find((r) => r.id === 'bm-2');
  assert.equal(linked.trigger, 'news');
  assert.equal(linked.news_articles.title, 't');
  assert.deepEqual(
    [orphan.trigger, orphan.reason, orphan.news_articles, orphan.news_analyses, orphan.macro_regime],
    [null, null, null, null, null]
  );
});
