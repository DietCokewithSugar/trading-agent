// 全局暂停开关:管理后台执行数据重置等危险操作期间,
// 暂停新闻轮询(runCycle)与止损监控(checkStops),避免新交易与删库并发。
let halted = false;

export function isHalted() {
  return halted;
}

export function setHalted(value) {
  halted = Boolean(value);
}
