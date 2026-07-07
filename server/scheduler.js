import { config } from './config.js';
import { runCycle } from './services/newsService.js';
import { takeSnapshot, getValuation } from './services/portfolio.js';
import { checkStops } from './services/riskMonitor.js';
import { maybeRunDailyReview } from './services/positionReview.js';
import { processPendingOrders } from './services/openQueue.js';
import { backfillForwardReturns } from './services/signalReturns.js';
import { refreshCalendar } from './services/macroCalendar.js';
import { refreshMarketCheck } from './services/marketCheck.js';
import { initMacroRegime, recomputeRegime } from './services/macroRegime.js';
import { maybeRunAllocation } from './services/allocator.js';
import {
  initShadowPortfolios,
  checkShadowStops,
  takeShadowSnapshots,
} from './services/shadowPortfolio.js';
import { makeSingleton } from './services/singleton.js';
import { getMarketSession } from './services/fmp.js';
import { broadcast, clientCount } from './services/bus.js';
import { pushLiveQuotes } from './services/quotesPush.js';
import { pollMirrorOrders, getLatestBrokerSnapshot } from './services/brokerMirror.js';
import { pollBrokerAccountOrders } from './services/brokerAccounts.js';
import { isBrokerEnabled } from './services/alpacaBroker.js';
import { getPrimaryValuation, isBrokerLedgerPrimary } from './services/primaryLedger.js';

// 休市时段净值几乎不变,快照降频到每 30 分钟一条(保持折线图连续),
// 同时避免对持仓报价的无谓 FMP 请求
const CLOSED_SNAPSHOT_MS = 30 * 60_000;

export function startScheduler() {
  const newsSec = Math.max(config.newsPollSeconds, 5);
  const quoteSec = Math.max(config.quotePushSeconds, 2);
  const snapSec = Math.max(config.snapshotSeconds, 15);
  const riskSec = Math.max(config.riskCheckSeconds, 10);

  // 统一防重入(singleton.js):每个周期任务都包成单飞版本——上一轮未结束的 tick
  // 直接跳过而不是叠加执行,卡死超过阈值周期性告警。模块内部已有的 running 旗标
  // 保留(它们还要防手动触发/API 入口的并发),这里是调度层对
  // "任务慢于 interval 导致重叠"的统一防线。
  const every = (ms, name, fn) => {
    const task = makeSingleton(name, fn);
    setInterval(() => {
      task().catch((err) => console.error(`[scheduler] ${name}失败: ${err.message}`));
    }, ms);
  };

  // 新闻轮询(秒级):平时只抓轻量的个股新闻,每约 5 分钟带一轮综合新闻/公告/Yahoo。
  // tick 只在真正执行时递增:被跳过的轮次不消耗全源抓取的节拍
  const fullEvery = Math.max(Math.round(300 / newsSec), 1);
  let tick = 0;
  every(newsSec * 1000, '新闻轮询', () => {
    tick += 1;
    return runCycle({ fullFetch: tick % fullEvery === 0, trigger: 'scheduler' });
  });

  // 实时报价推送:仅在有浏览器通过 SSE 在线时拉取报价,节省 API 配额。
  // 主账本开关(024)决定 portfolio 事件的数据源(券商模拟/内部,取数失败自动回退内部);
  // quotes 事件始终基于内部估值(候选池/个股弹窗与账本视图无关)
  every(quoteSec * 1000, '报价推送', async () => {
    if (!clientCount()) return;
    const opts = { quoteMaxAgeMs: Math.max(quoteSec * 1000 - 1000, 1000) };
    const internal = await getValuation(opts);
    broadcast(
      'portfolio',
      isBrokerLedgerPrimary() ? await getPrimaryValuation(opts) : { ...internal, ledger: 'internal' }
    );
    // 不 await:池符号报价慢(FMP 超时最长 20s)不能拖累 portfolio 推送节奏,
    // 模块内部有单飞旗标防重入,且 fail-open 永不 reject
    pushLiveQuotes(internal).catch(() => {});
  });

  // 净值快照(盈亏折线图数据点),休市时段降频;影子组合快照搭车(内部限频)。
  // 内部快照永远照常落库(引擎历史不断档);主账本为券商模拟时,
  // snapshot 广播改发最新券商净值快照(10 分钟粒度,图表一致性优先)
  let lastClosedSnapshotAt = 0;
  every(snapSec * 1000, '净值快照', async () => {
    if (getMarketSession() === 'closed') {
      if (Date.now() - lastClosedSnapshotAt < CLOSED_SNAPSHOT_MS) return;
      lastClosedSnapshotAt = Date.now();
    }
    const snap = await takeSnapshot();
    if (isBrokerLedgerPrimary()) {
      const brokerSnap = await getLatestBrokerSnapshot();
      if (brokerSnap) broadcast('snapshot', brokerSnap);
    } else {
      broadcast('snapshot', snap);
    }
    if (config.enableShadow) {
      await takeShadowSnapshots().catch((err) =>
        console.warn(`[shadow] 净值快照失败: ${err.message}`)
      );
    }
  });

  // 止损/止盈监控(与是否有访客在线无关)
  every(riskSec * 1000, '风控检查', checkStops);

  // 影子组合(017,消融实验):持仓止损/止盈与实盘同频监控
  //(报价基本命中实盘监控刚拉过的缓存,不额外耗配额)
  if (config.enableShadow) {
    every(riskSec * 1000, '影子止损监控', checkShadowStops);
  }

  // 每日持仓复查:每 10 分钟探测一次触发条件(盘中、美东指定小时后、当日未复查)
  every(10 * 60_000, '持仓复查', maybeRunDailyReview);

  // 开盘队列:休市期间挂起的信号在常规时段开盘后尽快按开盘价成交(非盘中自动跳过)
  every(Math.max(riskSec, 15) * 1000, '开盘队列处理', processPendingOrders);

  // 信号前瞻收益回填(评估层):每 10 分钟一批,到期的信号补 1h/1d/5d 前瞻收益
  every(10 * 60_000, '信号前瞻收益回填', backfillForwardReturns);

  // 券商模拟对照账本(021):回填在途对照单的真实撮合结果 + 限频净值对照快照
  //(未配置券商 key 时函数内直接跳过)
  if (isBrokerEnabled()) {
    every(60_000, '券商对照轮询', pollMirrorOrders);
  }

  // 多券商模拟账户(025):回填在途执行单 + 每账户限频净值快照。
  // 账户在运行时由管理页增删,循环无条件注册(无账户/缺表时函数内零成本返回)
  every(60_000, '券商账户轮询', pollBrokerAccountOrders);

  if (config.enableMacro) {
    // 经济日历刷新(黑窗与 surprise 数据源;套餐不含端点时模块内部自动停用)
    every(Math.max(config.calendarPollMinutes, 5) * 60_000, '经济日历刷新', refreshCalendar);

    // 宏观环境衰减重算:无新事件时风险分随时间衰减回 neutral,macro_shock 到期解除
    every(10 * 60_000, '宏观环境重算', () => recomputeRegime('decay'));

    // 资金分配器:每分钟探测,内部限速(盘中每 ALLOCATION_INTERVAL_MINUTES 一轮,
    // 开盘后的第一个 tick 立即执行,清算隔夜积累的候选;非盘中不执行)
    every(60_000, '资金分配', maybeRunAllocation);

    // 确定性市场核验(SPY 趋势 + VIX):周期刷新,失败只停用核验本身
    if (config.enableMarketCheck) {
      every(Math.max(config.marketCheckPollMinutes, 1) * 60_000, '市场核验刷新', refreshMarketCheck);
    }

    // 启动:加载上次宏观状态(重启延续)+ 先抓一次日历与市场核验
    setTimeout(() => {
      initMacroRegime().catch((err) => console.error(`[scheduler] 宏观状态加载失败: ${err.message}`));
      refreshCalendar().catch((err) => console.error(`[scheduler] 经济日历首抓失败: ${err.message}`));
      if (config.enableMarketCheck) {
        refreshMarketCheck().catch((err) =>
          console.error(`[scheduler] 市场核验首抓失败: ${err.message}`)
        );
      }
    }, 10_000);
  }

  // 影子组合启动:补建变体资金行(SPY 基准建仓失败时由快照循环重试)
  if (config.enableShadow) {
    setTimeout(() => {
      initShadowPortfolios().catch((err) =>
        console.warn(`[shadow] 初始化失败: ${err.message}`)
      );
    }, 8_000);
  }

  console.log(
    `[scheduler] 已启动: 新闻每 ${newsSec}s(每 ${fullEvery} 轮全源抓取) · 报价推送每 ${quoteSec}s · 快照每 ${snapSec}s · 风控每 ${riskSec}s`
  );

  // 启动后先跑一轮全源抓取
  setTimeout(() => {
    runCycle({ fullFetch: true, trigger: 'scheduler' }).catch((err) =>
      console.error(`[scheduler] 启动首轮失败: ${err.message}`)
    );
  }, 5_000);
}
