// 周期任务的统一防重入包装:setInterval 只管按点触发,不管上一轮是否结束——
// 任务偶发卡慢(外部 API 挂起、数据库慢查询)时同一任务会重叠执行,
// 轻则重复请求耗配额,重则并发读改写状态。包装后上一轮未结束的 tick 直接跳过,
// 卡死超过阈值周期性告警(每个告警周期最多一条,不刷屏)。
// 模块内部已有的 running 旗标(runCycle/checkStops/…)继续保留——它们还要防
// 手动触发与多入口并发,这里是调度层对"任务慢于 interval"的统一防线。

/**
 * 把异步任务包成单飞(singleton)版本:上一次调用未结束时再次调用直接返回
 * undefined(跳过),不排队不叠加;异常照常向调用方抛出(running 在 finally 复位)。
 *
 * @param {string} name 任务名(告警日志用)
 * @param {Function} fn 实际任务
 * @param {object} [opts]
 * @param {number} [opts.stuckWarnMs] 运行超过该时长仍未结束时,后续被跳过的 tick
 *   每隔该时长告警一次(默认 10 分钟;0 = 不告警)
 * @param {Function} [opts.now] 时钟注入(测试用)
 */
export function makeSingleton(name, fn, { stuckWarnMs = 10 * 60_000, now = Date.now } = {}) {
  let running = false;
  let startedAt = 0;
  let lastStuckWarnAt = 0;

  return async function singletonTask(...args) {
    if (running) {
      const elapsed = now() - startedAt;
      if (stuckWarnMs > 0 && elapsed >= stuckWarnMs && now() - lastStuckWarnAt >= stuckWarnMs) {
        lastStuckWarnAt = now();
        console.warn(
          `[scheduler] 任务「${name}」已运行 ${Math.round(elapsed / 60_000)} 分钟仍未结束,本次 tick 跳过`
        );
      }
      return undefined;
    }
    running = true;
    startedAt = now();
    lastStuckWarnAt = 0;
    try {
      return await fn(...args);
    } finally {
      running = false;
    }
  };
}
