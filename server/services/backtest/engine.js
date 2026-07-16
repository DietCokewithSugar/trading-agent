/**
 * 回测撮合引擎(032,纯函数):单标的独立账本、多头-only、全进全出(论文口径),
 * 所有成交都发生在日线收盘(基线)或按日线 OHLC 近似的括号价位(AI 策略),
 * 双边固定成本 costBps 对所有策略一致(默认 0,与论文对齐)。
 *
 * AI 策略镜像实盘规则:买入即挂 ±stopLossPercent/takeProfitPercent 括号
 * (execute_trade RPC 同口径,相对买入均价)、maxHoldHours 持有时限
 * (riskMonitor#max_hold)、同票新利好刷新持有时钟并上抬止盈(020,
 * holding.js#bumpTakeProfit)、利空信号全仓卖出(trigger 'news')。
 * 日线粒度近似(文档/UI 双处披露):括号触发只能看当日 OHLC ——
 * 跳空直接按开盘价成交(不给止损价优待),同根 K 线止损止盈皆触先算止损
 * (保守,riskMonitor 先例);到期/信号成交都落在收盘。
 */

import { bumpTakeProfit } from '../holding.js';

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 1e4) / 1e4;

/** 'YYYY-MM-DD' → 名义收盘时刻毫秒(统一取 21:00 UTC;仅用于差值比较,DST 误差不影响 24h 的整数倍) */
function barCloseMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 21, 0, 0);
}

function makeBook(initialValue) {
  return { cash: initialValue, quantity: 0, avgCost: null };
}

function buyAll(book, { date, price, costBps, trigger, trades }) {
  const fill = round4(price * (1 + costBps / 1e4));
  if (!(fill > 0) || !(book.cash > 0)) return false;
  const quantity = book.cash / fill;
  trades.push({
    date,
    side: 'buy',
    price: fill,
    quantity: round4(quantity),
    amount: round2(book.cash),
    trigger,
  });
  book.quantity = quantity;
  book.avgCost = fill;
  book.cash = 0;
  return true;
}

function sellAll(book, { date, price, costBps, trigger, trades }) {
  const fill = round4(price * (1 - costBps / 1e4));
  const proceeds = book.quantity * fill;
  trades.push({
    date,
    side: 'sell',
    price: fill,
    quantity: round4(book.quantity),
    amount: round2(proceeds),
    trigger,
    realized_pnl: round2((fill - book.avgCost) * book.quantity),
  });
  book.cash = proceeds;
  book.quantity = 0;
  book.avgCost = null;
}

function markEquity(equity, book, bar, initialValue) {
  const value = book.cash + book.quantity * bar.close;
  equity.push({
    date: bar.date,
    value: round2(value),
    pct: round4(((value - initialValue) / initialValue) * 100),
  });
}

/**
 * 窗口起点索引:bars 允许在用户窗口前带一段"指标暖机段"(编排层预取约 40 根),
 * 交易与净值都只从首根 date ≥ windowStart 的 K 线开始 —— 指标在暖机段完成收敛,
 * 短窗口(如 1 个月)的技术基线从窗口首日即可给出信号。缺省 0(无暖机,向后兼容)。
 */
function windowStartIndex(bars, windowStart) {
  if (!windowStart) return 0;
  const idx = bars.findIndex((b) => b.date >= windowStart);
  return idx === -1 ? bars.length : idx;
}

/**
 * 基线策略:targets[i] 为第 i 根收盘时决定的目标仓位,在第 i+1 根收盘执行
 * (shift-1,严格因果);entryAtFirstBar=true(买入持有)在窗口首根收盘直接建仓。
 * windowStart 见 windowStartIndex —— 暖机段只用于指标取值(targets[i-1]),不交易不计净值。
 */
export function runTargetStrategy({
  bars,
  targets,
  initialValue = 10000,
  costBps = 0,
  entryAtFirstBar = false,
  windowStart = null,
}) {
  const book = makeBook(initialValue);
  const trades = [];
  const equity = [];
  for (let i = windowStartIndex(bars, windowStart); i < bars.length; i++) {
    const desired = entryAtFirstBar ? 1 : i >= 1 ? targets[i - 1] : 0;
    if (desired === 1 && book.quantity === 0) {
      buyAll(book, { date: bars[i].date, price: bars[i].close, costBps, trigger: 'signal', trades });
    } else if (desired === 0 && book.quantity > 0) {
      sellAll(book, { date: bars[i].date, price: bars[i].close, costBps, trigger: 'signal', trades });
    }
    markEquity(equity, book, bars[i], initialValue);
  }
  return { equity, trades, endState: endState(book) };
}

/**
 * AI 新闻策略:signals 为 aiSignals#deriveSignals 的输出(每执行日至多一条)。
 * 逐日事件顺序(持仓时):
 *  ① 开盘缺口:open ≤ stop → 按 open 全平(stop_loss);否则 open ≥ take → 按 open 全平(take_profit)
 *  ② 盘中:low ≤ stop → 按 stop 价全平;否则 high ≥ take → 按 take 价全平(同根先止损,保守)
 *  ③ 收盘:利空信号 → 全平(news)
 *  ④ 收盘:持有超时(maxHoldHours)→ 全平(max_hold)
 *  ⑤ 收盘:利好信号 → 持仓则刷新持有时钟 + 上抬止盈(020);空仓则全现金买入(括号自次日生效)
 *  ⑥ 收盘价 mark-to-market
 * 执行日不在 bars 里(数据缺口)的信号顺延到下一根可用 K 线。窗口结束不强平(按市值计入 CR)。
 */
export function runAiStrategy({
  bars,
  signals,
  initialValue = 10000,
  costBps = 0,
  stopLossPercent = 2,
  takeProfitPercent = 2,
  takeProfitStepPercent = 1,
  maxHoldHours = 48,
  windowStart = null,
}) {
  const book = makeBook(initialValue);
  const trades = [];
  const equity = [];
  let stop = null;
  let take = null;
  let holdDeadlineMs = null;
  let entryIndex = -1;
  let signalIdx = 0;
  const holdMs = maxHoldHours > 0 ? maxHoldHours * 3600_000 : null;

  const closePosition = (date, price, trigger) => {
    sellAll(book, { date, price, costBps, trigger, trades });
    stop = null;
    take = null;
    holdDeadlineMs = null;
    entryIndex = -1;
  };

  // AI 信号执行日本就落在用户窗口内,暖机段跳过只为与基线的净值日期轴对齐
  for (let i = windowStartIndex(bars, windowStart); i < bars.length; i++) {
    const bar = bars[i];

    // ①② 括号检查:买入当根不查(成交发生在收盘,括号自次日生效)
    if (book.quantity > 0 && entryIndex !== i) {
      if (stop !== null && bar.open <= stop) {
        closePosition(bar.date, bar.open, 'stop_loss');
      } else if (take !== null && bar.open >= take) {
        closePosition(bar.date, bar.open, 'take_profit');
      } else if (stop !== null && bar.low <= stop) {
        closePosition(bar.date, stop, 'stop_loss');
      } else if (take !== null && bar.high >= take) {
        closePosition(bar.date, take, 'take_profit');
      }
    }

    // 收集执行日 ≤ 当前 K 线的信号(数据缺口顺延);同根多条时逐条按序处理
    let bullish = null;
    let bearish = null;
    while (signalIdx < signals.length && signals[signalIdx].execution_date <= bar.date) {
      const sig = signals[signalIdx];
      if (sig.direction === 'bearish') bearish = sig;
      else bullish = sig;
      signalIdx += 1;
    }

    // ③ 利空:全平
    if (bearish && book.quantity > 0) {
      closePosition(bar.date, bar.close, 'news');
    }

    // ④ 持有超时:到期日收盘全平
    if (book.quantity > 0 && holdDeadlineMs !== null && barCloseMs(bar.date) >= holdDeadlineMs) {
      closePosition(bar.date, bar.close, 'max_hold');
    }

    // ⑤ 利好:持仓刷新(020),空仓建仓
    if (bullish) {
      if (book.quantity > 0) {
        if (holdMs !== null) holdDeadlineMs = barCloseMs(bar.date) + holdMs;
        take = bumpTakeProfit({
          takeProfit: take,
          avgCost: book.avgCost,
          stepPercent: takeProfitStepPercent,
          defaultTakeProfitPercent: takeProfitPercent,
        });
      } else if (!bearish) {
        // 同根先空后多的极端序列不再反手建仓 —— 与"同日多空冲突搁置"同精神
        if (buyAll(book, { date: bar.date, price: bar.close, costBps, trigger: 'news', trades })) {
          stop = round4(book.avgCost * (1 - stopLossPercent / 100));
          take = round4(book.avgCost * (1 + takeProfitPercent / 100));
          holdDeadlineMs = holdMs !== null ? barCloseMs(bar.date) + holdMs : null;
          entryIndex = i;
        }
      }
    }

    // ⑥ 收盘 mark-to-market
    markEquity(equity, book, bar, initialValue);
  }
  return { equity, trades, endState: endState(book, { stop, take }) };
}

function endState(book, extras = {}) {
  return {
    holding: book.quantity > 0,
    quantity: round4(book.quantity),
    avg_cost: book.avgCost !== null ? round4(book.avgCost) : null,
    cash: round2(book.cash),
    stop_loss: extras.stop ?? null,
    take_profit: extras.take ?? null,
  };
}
