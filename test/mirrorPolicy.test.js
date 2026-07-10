import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mirrorLimitPrice,
  remainingQty,
  nextRetryClientOrderId,
  buyDriftPercent,
  planMirrorFollowUp,
  planBuyFunding,
  committedBuyNotional,
  planReconcile,
} from '../server/services/mirrorPolicy.js';

// 默认策略参数(与 config 默认一致):slack 1%,重挂上限 3,买单追单,漂移上限 5%,
// 顺延买单时效 96h(沿用实盘挂单时效)
const CFG = { slackPercent: 1, maxRetries: 3, buyRetry: 'chase', buyDriftCapPercent: 5, deferredBuyMaxAgeHours: 96 };

test('remainingQty:整单/部分成交/null 安全/超额 clamp 0', () => {
  assert.equal(remainingQty({ qty: 10, filledQty: 0 }), 10);
  assert.equal(remainingQty({ qty: 10, filledQty: null }), 10);
  assert.equal(remainingQty({ qty: 10, filledQty: 4 }), 6);
  assert.equal(remainingQty({ qty: 10, filledQty: 12 }), 0);
  assert.equal(remainingQty({ qty: 0, filledQty: 0 }), 0);
  assert.equal(remainingQty({ qty: null, filledQty: null }), 0);
});

test('nextRetryClientOrderId:剥掉尾部 -rN 再拼新序号', () => {
  assert.equal(nextRetryClientOrderId('trade-12', 2), 'trade-12-r2');
  assert.equal(nextRetryClientOrderId('trade-12-r2', 3), 'trade-12-r3');
  assert.equal(nextRetryClientOrderId('shadow-9-a5', 2), 'shadow-9-a5-r2');
  assert.equal(nextRetryClientOrderId('shadow-9-a5-r2', 3), 'shadow-9-a5-r3');
  assert.equal(nextRetryClientOrderId('reconcile-FRMI-2026-07-08', 2), 'reconcile-FRMI-2026-07-08-r2');
});

test('buyDriftPercent:带符号漂移,非法入参 null', () => {
  assert.equal(buyDriftPercent({ internalPrice: 100, currentPrice: 106 }), 6);
  assert.equal(buyDriftPercent({ internalPrice: 100, currentPrice: 95 }), -5);
  assert.equal(buyDriftPercent({ internalPrice: 0, currentPrice: 95 }), null);
  assert.equal(buyDriftPercent({ internalPrice: 100, currentPrice: null }), null);
});

// ── 顺延单(deferred)──

test('顺延单:休市继续等,无报价继续等', () => {
  const row = { status: 'deferred', side: 'sell', qty: 10, internal_price: 8.3 };
  assert.equal(planMirrorFollowUp({ row, session: 'closed', currentPrice: 8, config: CFG }).action, 'wait');
  assert.equal(planMirrorFollowUp({ row, session: 'pre', currentPrice: null, config: CFG }).action, 'wait');
});

test('顺延卖单:开盘按实时价挂限价(隔夜跳空也照卖,保证收敛)', () => {
  // FRMI 场景:内部 8.30 卖出,隔夜跳空到 7.00 —— 旧逻辑按 8.22 挂必死单,新逻辑按 6.93 实时价
  const row = { status: 'deferred', side: 'sell', qty: 10, internal_price: 8.3 };
  const plan = planMirrorFollowUp({ row, session: 'pre', currentPrice: 7, config: CFG });
  assert.equal(plan.action, 'submit_deferred');
  assert.equal(plan.limitPrice, 6.93);
  assert.equal(plan.extendedHours, true);
  // 常规时段不带盘外标记
  assert.equal(planMirrorFollowUp({ row, session: 'regular', currentPrice: 7, config: CFG }).extendedHours, false);
});

test('顺延买单:漂移 ≤5% 照挂,向下跳空(更便宜)不设限,超限放弃', () => {
  const row = { status: 'deferred', side: 'buy', qty: 10, internal_price: 100 };
  const ok = planMirrorFollowUp({ row, session: 'regular', currentPrice: 104, config: CFG });
  assert.equal(ok.action, 'submit_deferred');
  assert.equal(ok.limitPrice, 105.04);
  // 向下跳空:比内部账本更便宜建仓,严格有利
  assert.equal(planMirrorFollowUp({ row, session: 'regular', currentPrice: 80, config: CFG }).action, 'submit_deferred');
  const over = planMirrorFollowUp({ row, session: 'regular', currentPrice: 106, config: CFG });
  assert.equal(over.action, 'abandon');
  assert.match(over.note, /超限/);
});

test('顺延买单超龄作废:超过时效直接放弃(不依赖时段/报价),卖单不设时效', () => {
  const now = Date.parse('2026-07-09T12:00:00Z');
  const oldAt = new Date(now - 97 * 3600_000).toISOString();
  const freshAt = new Date(now - 1 * 3600_000).toISOString();
  const buy = (submittedAt) => ({ status: 'deferred', side: 'buy', qty: 10, internal_price: 100, submitted_at: submittedAt });
  // 超龄买单:即便休市/无报价也立即作废
  const expired = planMirrorFollowUp({ row: buy(oldAt), session: 'closed', currentPrice: null, config: CFG, now });
  assert.equal(expired.action, 'abandon');
  assert.match(expired.note, /超过 96 小时/);
  // 未超龄买单照常等待/提交
  assert.equal(planMirrorFollowUp({ row: buy(freshAt), session: 'closed', currentPrice: null, config: CFG, now }).action, 'wait');
  assert.equal(planMirrorFollowUp({ row: buy(freshAt), session: 'regular', currentPrice: 100, config: CFG, now }).action, 'submit_deferred');
  // 卖单必须收敛,超龄照常提交
  const sell = { status: 'deferred', side: 'sell', qty: 10, internal_price: 100, submitted_at: oldAt };
  assert.equal(planMirrorFollowUp({ row: sell, session: 'regular', currentPrice: 100, config: CFG, now }).action, 'submit_deferred');
  // 时效未配置(0/缺失)→ 不作废
  assert.equal(
    planMirrorFollowUp({ row: buy(oldAt), session: 'regular', currentPrice: 100, config: { ...CFG, deferredBuyMaxAgeHours: 0 }, now }).action,
    'submit_deferred'
  );
});

test('顺延卖单长期无报价:开盘时段升级市价单(毒行终结器),休市/未超龄/有报价不升级', () => {
  const now = Date.parse('2026-07-09T12:00:00Z');
  const oldAt = new Date(now - 97 * 3600_000).toISOString();
  const row = { status: 'deferred', side: 'sell', qty: 10, filled_qty: null, internal_price: 8.3, submitted_at: oldAt };
  const plan = planMirrorFollowUp({ row, session: 'regular', currentPrice: null, config: CFG, now });
  assert.equal(plan.action, 'market_escalate');
  assert.equal(plan.qty, 10);
  assert.equal(plan.extendedHours, false);
  // 休市不升级(报价缺失可能只是数据源暂歇,等可交易时段)
  assert.equal(planMirrorFollowUp({ row, session: 'closed', currentPrice: null, config: CFG, now }).action, 'wait');
  // 未超龄:继续等报价
  const fresh = { ...row, submitted_at: new Date(now - 3600_000).toISOString() };
  assert.equal(planMirrorFollowUp({ row: fresh, session: 'regular', currentPrice: null, config: CFG, now }).action, 'wait');
  // 有报价:正常限价提交,不升级
  assert.equal(planMirrorFollowUp({ row, session: 'regular', currentPrice: 7, config: CFG, now }).action, 'submit_deferred');
});

// ── 镜像买单资金约束 ──

test('planBuyFunding:足额提交,回款可期顺延,无回款放弃,读数缺失顺延', () => {
  // 足额
  assert.equal(planBuyFunding({ notional: 1000, availableCash: 1500 }).action, 'submit');
  // 不足 + 在途卖单回款可期 → 等
  const wait = planBuyFunding({ notional: 1000, availableCash: 200, hasPendingSellProceeds: true });
  assert.equal(wait.action, 'wait');
  // 不足 + 无回款 → 放弃(绝不动用保证金)
  const abandon = planBuyFunding({ notional: 1000, availableCash: 200, hasPendingSellProceeds: false });
  assert.equal(abandon.action, 'abandon');
  assert.match(abandon.note, /现金不足/);
  // 保证金账户现金已为负:同样放弃
  assert.equal(planBuyFunding({ notional: 1000, availableCash: -500 }).action, 'abandon');
  // 现金读数不可得 → 顺延下轮再看
  assert.equal(planBuyFunding({ notional: 1000, availableCash: null }).action, 'wait');
  // 金额非法 → 放弃
  assert.equal(planBuyFunding({ notional: 0, availableCash: 1500 }).action, 'abandon');
});

test('committedBuyNotional:在途买单的现金占用(cash 不含挂单冻结,须本地记账)', () => {
  const rows = [
    { side: 'buy', qty: 10, filled_qty: null, limit_price: 101, internal_price: 100 }, // 全额在途:1010
    { side: 'buy', qty: 10, filled_qty: 4, limit_price: 50, internal_price: 49 },      // 余量 6×50=300
    { side: 'buy', qty: 10, filled_qty: null, limit_price: null, internal_price: 20 }, // 无限价退回内部价:200
    { side: 'sell', qty: 100, filled_qty: null, limit_price: 99, internal_price: 100 }, // 卖单不占现金
    { side: 'buy', qty: 10, filled_qty: 10, limit_price: 30, internal_price: 30 },     // 已全部成交:0
  ];
  assert.equal(committedBuyNotional(rows), 1510);
  assert.equal(committedBuyNotional([]), 0);
  assert.equal(committedBuyNotional(null), 0);
});

// ── 在途单终态迁移 ──

test('非终态/已全部成交:不跟进', () => {
  const row = { status: 'submitted', side: 'sell', qty: 10, filled_qty: 10, internal_price: 100, attempt: 1 };
  assert.equal(planMirrorFollowUp({ row, brokerStatus: 'filled', session: 'regular', currentPrice: 100, config: CFG }).action, 'none');
  assert.equal(planMirrorFollowUp({ row, brokerStatus: 'expired', session: 'regular', currentPrice: 100, config: CFG }).action, 'none');
});

test('卖单过期:限价重挂(实时价−slack,数量=余量),报价缺失则 wait', () => {
  const row = { status: 'submitted', side: 'sell', qty: 10, filled_qty: 4, internal_price: 8.3, attempt: 1 };
  const plan = planMirrorFollowUp({ row, brokerStatus: 'expired', session: 'regular', currentPrice: 7, config: CFG });
  assert.equal(plan.action, 'retry_limit');
  assert.equal(plan.qty, 6);
  assert.equal(plan.limitPrice, 6.93);
  assert.equal(planMirrorFollowUp({ row, brokerStatus: 'expired', session: 'regular', currentPrice: null, config: CFG }).action, 'wait');
});

test('卖单:休市时段的终态迁移 → 顺延重挂(不再用过期报价直接挂)', () => {
  const row = { status: 'submitted', side: 'sell', qty: 10, internal_price: 8.3, attempt: 1 };
  const plan = planMirrorFollowUp({ row, brokerStatus: 'expired', session: 'closed', currentPrice: null, config: CFG });
  assert.equal(plan.action, 'retry_defer');
  assert.equal(plan.qty, 10);
});

test('卖单:限价重试耗尽后升级一次市价单(必须 ext=false),之后交对账兜底', () => {
  const mk = (attempt) => ({ status: 'submitted', side: 'sell', qty: 10, internal_price: 8.3, attempt });
  assert.equal(planMirrorFollowUp({ row: mk(3), brokerStatus: 'expired', session: 'regular', currentPrice: 7, config: CFG }).action, 'retry_limit');
  const esc = planMirrorFollowUp({ row: mk(4), brokerStatus: 'expired', session: 'post', currentPrice: null, config: CFG });
  assert.equal(esc.action, 'market_escalate');
  assert.equal(esc.extendedHours, false);
  assert.equal(planMirrorFollowUp({ row: mk(5), brokerStatus: 'expired', session: 'regular', currentPrice: 7, config: CFG }).action, 'none');
});

test('卖单 maxRetries=0:直接升级市价单', () => {
  const row = { status: 'submitted', side: 'sell', qty: 10, internal_price: 8.3, attempt: 1 };
  const plan = planMirrorFollowUp({ row, brokerStatus: 'canceled', session: 'regular', currentPrice: 7, config: { ...CFG, maxRetries: 0 } });
  assert.equal(plan.action, 'market_escalate');
});

test('卖单被拒(rejected):收敛优先,照走重挂', () => {
  const row = { status: 'submitted', side: 'sell', qty: 10, internal_price: 8.3, attempt: 1 };
  assert.equal(planMirrorFollowUp({ row, brokerStatus: 'rejected', session: 'regular', currentPrice: 7, config: CFG }).action, 'retry_limit');
});

test('买单过期:漂移内追单,超限/次数用尽/被拒/关闭追单 → 放弃', () => {
  const mk = (attempt) => ({ status: 'submitted', side: 'buy', qty: 10, internal_price: 100, attempt });
  const chase = planMirrorFollowUp({ row: mk(1), brokerStatus: 'expired', session: 'regular', currentPrice: 103, config: CFG });
  assert.equal(chase.action, 'retry_limit');
  assert.equal(chase.limitPrice, 104.03);
  // 漂移超限
  const over = planMirrorFollowUp({ row: mk(1), brokerStatus: 'expired', session: 'regular', currentPrice: 106, config: CFG });
  assert.equal(over.action, 'none');
  assert.match(over.note, /超限/);
  // 次数用尽
  assert.equal(planMirrorFollowUp({ row: mk(4), brokerStatus: 'expired', session: 'regular', currentPrice: 103, config: CFG }).action, 'none');
  // 券商拒单(买力/标的状态)不追
  assert.equal(planMirrorFollowUp({ row: mk(1), brokerStatus: 'rejected', session: 'regular', currentPrice: 103, config: CFG }).action, 'none');
  // 追单整体关闭
  assert.equal(planMirrorFollowUp({ row: mk(1), brokerStatus: 'expired', session: 'regular', currentPrice: 103, config: { ...CFG, buyRetry: 'off' } }).action, 'none');
  // 休市迁移 → 顺延追单(开盘时再做漂移判定)
  assert.equal(planMirrorFollowUp({ row: mk(1), brokerStatus: 'expired', session: 'closed', currentPrice: null, config: CFG }).action, 'retry_defer');
  // 报价缺失 → wait
  assert.equal(planMirrorFollowUp({ row: mk(1), brokerStatus: 'expired', session: 'regular', currentPrice: null, config: CFG }).action, 'wait');
});

// ── 对账清理 ──

test('planReconcile:券商独有全平、超额减仓、dust 内忽略、在途/内部独有跳过', () => {
  const plans = planReconcile({
    brokerPositions: [
      { symbol: 'FRMI', qty: '708.8908', qty_available: '708.8908' }, // 内部已卖出 → 全平
      { symbol: 'AAPL', qty: '12', qty_available: '12' },             // 内部 10 → 减仓 2
      { symbol: 'MSFT', qty: '10.005', qty_available: '10.005' },     // 超额 0.005 < dust → 忽略
      { symbol: 'NVDA', qty: '20', qty_available: '20' },             // 有在途单 → 跳过
      { symbol: 'TSLA', qty: '0', qty_available: '0' },               // 无可卖数量 → 忽略
    ],
    internalPositions: [
      { symbol: 'AAPL', quantity: 10 },
      { symbol: 'MSFT', quantity: 10 },
      { symbol: 'GOOG', quantity: 5 }, // 内部独有:永不买入对账
    ],
    inflightSymbols: ['NVDA'],
  });
  assert.deepEqual(plans, [
    { symbol: 'FRMI', qty: 708.8908, reason: 'orphan' },
    { symbol: 'AAPL', qty: 2, reason: 'excess' },
  ]);
});

test('planReconcile:qty_available 优先于 qty(锁在未成交单里的股数不可卖)', () => {
  const plans = planReconcile({
    brokerPositions: [{ symbol: 'FRMI', qty: '100', qty_available: '60' }],
    internalPositions: [],
    inflightSymbols: [],
  });
  assert.deepEqual(plans, [{ symbol: 'FRMI', qty: 60, reason: 'orphan' }]);
});

test('planReconcile:空入参安全', () => {
  assert.deepEqual(planReconcile({ brokerPositions: null, internalPositions: null, inflightSymbols: null }), []);
});

test('mirrorLimitPrice 迁移到 mirrorPolicy 后行为不变', () => {
  assert.equal(mirrorLimitPrice({ side: 'buy', price: 100, slackPercent: 1 }), 101);
  assert.equal(mirrorLimitPrice({ side: 'sell', price: 100, slackPercent: 1 }), 99);
  assert.equal(mirrorLimitPrice({ side: 'buy', price: 0, slackPercent: 1 }), null);
});
