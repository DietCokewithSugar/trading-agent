import cron from 'node-cron';
import { config } from './config.js';
import { runCycle } from './services/newsService.js';

export function startScheduler() {
  const minutes = Math.min(Math.max(Math.round(config.newsPollMinutes), 1), 59);
  const expr = `*/${minutes} * * * *`;
  cron.schedule(expr, () => {
    runCycle().catch((err) => console.error(`[scheduler] 周期任务失败: ${err.message}`));
  });
  console.log(`[scheduler] 已启动,每 ${minutes} 分钟运行一轮新闻抓取/分析/交易`);

  // 启动后稍等片刻先跑一轮
  setTimeout(() => {
    runCycle().catch((err) => console.error(`[scheduler] 启动首轮失败: ${err.message}`));
  }, 10_000);
}
