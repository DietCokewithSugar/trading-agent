import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeShadowSpend,
  applyBuy,
  applySell,
  unscaleFraction,
  unapplyScale,
  pickTopBlocked,
  valuePositions,
  prunePendingSignals,
  toRotationPositions,
} from '../server/services/shadowEngine.js';

const caps = { maxBuyCashFraction: 0.2, maxPositionFraction: 0.25, minOrderAmount: 50 };

test('computeShadowSpend: 比例×总值与单笔现金帽取小', () => {
  // 10% × 100k = 10000,低于 20% 单笔帽与现金
  assert.equal(
    computeShadowSpend({ fraction: 0.1, cash: 50000, totalValue: 100000, caps }),
    10000
  );
  // 50% 请求被单笔帽钳到 20% × 100k = 20000
  assert.equal(
    computeShadowSpend({ fraction: 0.5, cash: 50000, totalValue: 100000, caps }),
    20000
  );
  // 现金不足时按现金
  assert.equal(computeShadowSpend({ fraction: 0.5, cash: 3000, totalValue: 100000, caps }), 3000);
});

test('computeShadowSpend: 单票持仓帽与最小金额', () => {
  // 已持有 24k,买后不得超过 25% × 100k = 25k → 只能再买 1000
  assert.equal(
    computeShadowSpend({ fraction: 0.1, cash: 50000, totalValue: 100000, positionValue: 24000, caps }),
    1000
  );
  // 帽后低于下限 → 0(跳过)
  assert.equal(
    computeShadowSpend({ fraction: 0.1, cash: 50000, totalValue: 100000, positionValue: 24980, caps }),
    0
  );
  assert.equal(computeShadowSpend({ fraction: 0.0001, cash: 50000, totalValue: 100000, caps }), 0);
});

test('computeShadowSpend: benchmark 全仓建仓只受现金约束', () => {
  assert.equal(
    computeShadowSpend({ fraction: 1, cash: 100000, totalValue: 100000, benchmark: true, caps }),
    100000
  );
  // 非法输入返回 0
  assert.equal(computeShadowSpend({ fraction: 1, cash: 0, totalValue: 100000, caps }), 0);
  assert.equal(computeShadowSpend({ fraction: 0, cash: 100000, totalValue: 100000, caps }), 0);
});

test('applyBuy: 开新仓按成交价均价并设止损/止盈', () => {
  const pos = applyBuy(null, { quantity: 10, amount: 1000, stopLossPercent: 8, takeProfitPercent: 20 });
  assert.equal(pos.quantity, 10);
  assert.equal(pos.avg_cost, 100);
  assert.equal(pos.stop_loss, 92);
  assert.equal(pos.take_profit, 120);
});

test('applyBuy: 加仓为加权平均成本,不传止损时保留原值', () => {
  const existing = { quantity: 10, avg_cost: 100, stop_loss: 92, take_profit: 120 };
  const pos = applyBuy(existing, { quantity: 10, amount: 1200 });
  assert.equal(pos.quantity, 20);
  assert.equal(pos.avg_cost, 110); // (10×100 + 1200) / 20
  assert.equal(pos.stop_loss, 92);
  assert.equal(pos.take_profit, 120);
});

test('applyBuy: takeProfitPercent=null 不设止盈(trailing_only 变体,023)', () => {
  // 开新仓:止盈留空,离场只靠移动止损棘轮/持有时限
  const fresh = applyBuy(null, { quantity: 10, amount: 1000, stopLossPercent: 2, takeProfitPercent: null });
  assert.equal(fresh.stop_loss, 98);
  assert.equal(fresh.take_profit, null);
  // 加仓:原本无止盈的持仓保持无止盈
  const added = applyBuy(fresh, { quantity: 10, amount: 1200, stopLossPercent: 2, takeProfitPercent: null });
  assert.equal(added.take_profit, null);
  assert.equal(added.stop_loss, Math.round(110 * 0.98 * 10000) / 10000, '止损按新均价重设');
});

test('toRotationPositions: 影子持仓补齐腾位选仓字段,无报价的持仓丢弃(024)', () => {
  const prices = new Map([
    ['AAPL', 210],
    ['TSLA', 90],
  ]);
  const rows = toRotationPositions(
    [
      { symbol: 'AAPL', quantity: 10, avg_cost: 200, take_profit: 212 },
      { symbol: 'TSLA', quantity: 5, avg_cost: 100, take_profit: 104 },
      { symbol: 'NOPX', quantity: 3, avg_cost: 50, take_profit: 52 }, // 无报价 → 丢弃
    ],
    prices
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    symbol: 'AAPL',
    current_price: 210,
    take_profit: 212,
    avg_cost: 200,
    unrealized_pnl: 100,
  });
  assert.equal(rows[1].unrealized_pnl, -50, '浮亏照算(由 pickRotationSell 过滤)');
  // take_profit null 原样透传(trailing 类持仓由 pickRotationSell 自然跳过)
  const nullTp = toRotationPositions([{ symbol: 'X', quantity: 1, avg_cost: 10, take_profit: null }], new Map([['X', 12]]));
  assert.equal(nullTp[0].take_profit, null);
  assert.equal(toRotationPositions(null, prices).length, 0);
});

test('applySell: 部分卖出与盈亏', () => {
  const settle = applySell({ quantity: 20, avg_cost: 100 }, 0.5, 110);
  assert.equal(settle.quantity, 10);
  assert.equal(settle.remaining, 10);
  assert.equal(settle.amount, 1100);
  assert.equal(settle.realizedPnl, 100);
});

test('applySell: fraction≥0.99 或余量过小时清仓', () => {
  assert.equal(applySell({ quantity: 20, avg_cost: 100 }, 1, 90).remaining, 0);
  assert.equal(applySell({ quantity: 20, avg_cost: 100 }, 0.99, 90).quantity, 20);
  // 余量低于 0.0001 股按清仓处理
  const tiny = applySell({ quantity: 10.00005, avg_cost: 100 }, 0.99999, 100);
  assert.equal(tiny.remaining, 0);
});

test('unscaleFraction: 还原消融层缩放,非法系数不放大', () => {
  assert.equal(unscaleFraction(0.05, 0.5), 0.1); // 风控官缩仓 ×0.5 → 还原翻倍
  assert.equal(unscaleFraction(0.05, 1), 0.05); // 未缩放
  assert.equal(unscaleFraction(0.05, 0), 0.05); // scale=0 不除(避免 Infinity)
  assert.equal(unscaleFraction(0.05, null), 0.05);
  assert.equal(unscaleFraction(0, 0.5), 0);
});

test('unapplyScale: 双向还原宏观分量,非法系数不放大', () => {
  assert.equal(unapplyScale(0.05, 0.5), 0.1); // risk_off ×0.5 → 还原翻倍
  assert.equal(unapplyScale(0.06, 1.2), 0.05); // risk_on ×1.2 → 还原缩小
  assert.equal(unapplyScale(0.05, 1), 0.05); // 未缩放
  assert.equal(unapplyScale(0.05, 0), 0.05); // scale=0 不除(避免 Infinity)
  assert.equal(unapplyScale(0.05, null), 0.05);
  assert.equal(unapplyScale(0, 0.5), 0);
});

test('pickTopBlocked: 按当前分降序取前 N,跳过已买与缺 analysis_id 的', () => {
  const candidates = [
    { symbol: 'A', analysis_id: 1, current_score: 0.5 },
    { symbol: 'B', analysis_id: 2, current_score: 0.9 },
    { symbol: 'C', analysis_id: 3, current_score: 0.7 },
    { symbol: 'D', analysis_id: null, current_score: 1.0 },
  ];
  const picked = pickTopBlocked(candidates, { max: 2, excludeAnalysisIds: new Set([2]) });
  assert.deepEqual(picked.map((c) => c.symbol), ['C', 'A']);
  assert.equal(pickTopBlocked(candidates, { max: 0 }).length, 0);
  assert.equal(pickTopBlocked(null).length, 0);
});

test('valuePositions: 报价缺失退回平均成本', () => {
  const positions = [
    { symbol: 'A', quantity: 10, avg_cost: 100 },
    { symbol: 'B', quantity: 5, avg_cost: 50 },
  ];
  const prices = new Map([['A', 110]]);
  const { positionsValue, totalValue } = valuePositions(positions, prices, 1000);
  assert.equal(positionsValue, 1350); // 10×110 + 5×50
  assert.equal(totalValue, 2350);
});

// ── 休市顺延信号队列的修剪 ──

test('prunePendingSignals:超龄作废、超容丢最老、顺序保持', () => {
  const now = 1_000_000_000;
  const hour = 3600_000;
  const entries = [
    { id: 'old', queuedAt: now - 100 * hour }, // 超龄(>96h)
    { id: 'a', queuedAt: now - 10 * hour },
    { id: 'b', queuedAt: now - 5 * hour },
    { id: 'c', queuedAt: now - 1 * hour },
  ];
  const r1 = prunePendingSignals(entries, { now, maxAgeMs: 96 * hour, maxSize: 500 });
  assert.equal(r1.expired, 1);
  assert.equal(r1.dropped, 0);
  assert.deepEqual(r1.kept.map((e) => e.id), ['a', 'b', 'c']);

  // 超容:丢弃最老的,保留最新的 maxSize 条
  const r2 = prunePendingSignals(entries, { now, maxAgeMs: 96 * hour, maxSize: 2 });
  assert.equal(r2.dropped, 1);
  assert.deepEqual(r2.kept.map((e) => e.id), ['b', 'c']);

  // 缺 queuedAt 的异常条目按超龄处理;空输入安全
  const r3 = prunePendingSignals([{ id: 'x' }], { now, maxAgeMs: hour, maxSize: 10 });
  assert.equal(r3.expired, 1);
  assert.equal(r3.kept.length, 0);
  assert.equal(prunePendingSignals(null, { now, maxAgeMs: hour, maxSize: 10 }).kept.length, 0);
});
