import { config } from './config.js';
import { runCycle } from './services/newsService.js';
import { takeSnapshot, getValuation } from './services/portfolio.js';
import { checkStops } from './services/riskMonitor.js';
import { getMarketSession } from './services/fmp.js';
import { broadcast, clientCount } from './services/bus.js';

// 休市时段净值几乎不变,快照降频到每 30 分钟一条(保持折线图连续),
// 同时避免对持仓报价的无谓 FMP 请求
const CLOSED_SNAPSHOT_MS = 30 * 60_000;

export function startScheduler() {
  const newsSec = Math.max(config.newsPollSeconds, 5);
  const quoteSec = Math.max(config.quotePushSeconds, 2);
  const snapSec = Math.max(config.snapshotSeconds, 15);
  const riskSec = Math.max(config.riskCheckSeconds, 10);

  // 新闻轮询(秒级):平时只抓轻量的个股新闻,每约 5 分钟带一轮综合新闻/公告/Yahoo
  const fullEvery = Math.max(Math.round(300 / newsSec), 1);
  let tick = 0;
  setInterval(() => {
    tick += 1;
    runCycle({ fullFetch: tick % fullEvery === 0 }).catch((err) =>
      console.error(`[scheduler] 新闻轮询失败: ${err.message}`)
    );
  }, newsSec * 1000);

  // 实时报价推送:仅在有浏览器通过 SSE 在线时拉取报价,节省 API 配额
  let pushing = false;
  setInterval(async () => {
    if (!clientCount() || pushing) return;
    pushing = true;
    try {
      const valuation = await getValuation({
        quoteMaxAgeMs: Math.max(quoteSec * 1000 - 1000, 1000),
      });
      broadcast('portfolio', valuation);
    } catch (err) {
      console.error(`[scheduler] 报价推送失败: ${err.message}`);
    } finally {
      pushing = false;
    }
  }, quoteSec * 1000);

  // 净值快照(盈亏折线图数据点),休市时段降频
  let lastClosedSnapshotAt = 0;
  setInterval(async () => {
    try {
      if (getMarketSession() === 'closed') {
        if (Date.now() - lastClosedSnapshotAt < CLOSED_SNAPSHOT_MS) return;
        lastClosedSnapshotAt = Date.now();
      }
      const snap = await takeSnapshot();
      broadcast('snapshot', snap);
    } catch (err) {
      console.error(`[scheduler] 快照失败: ${err.message}`);
    }
  }, snapSec * 1000);

  // 止损/止盈监控(与是否有访客在线无关)
  setInterval(() => {
    checkStops().catch((err) => console.error(`[scheduler] 风控检查失败: ${err.message}`));
  }, riskSec * 1000);

  console.log(
    `[scheduler] 已启动: 新闻每 ${newsSec}s(每 ${fullEvery} 轮全源抓取) · 报价推送每 ${quoteSec}s · 快照每 ${snapSec}s · 风控每 ${riskSec}s`
  );

  // 启动后先跑一轮全源抓取
  setTimeout(() => {
    runCycle({ fullFetch: true }).catch((err) =>
      console.error(`[scheduler] 启动首轮失败: ${err.message}`)
    );
  }, 5_000);
}
