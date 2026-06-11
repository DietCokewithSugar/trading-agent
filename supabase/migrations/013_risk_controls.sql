-- 013: 组合级硬风控 — 人工交易暂停开关(kill switch)。
-- 只拦新开买入(新闻买入 + 开盘队列买单),所有卖出(新闻/止损/止盈/复查)不受影响:
-- 暂停开关绝不能禁用保护性退出。
-- 与 halt.js(管理重置期间的全局调度暂停)是两个独立机制:
-- 重置暂停是短暂的系统操作,本开关是管理员的人工风控决策,需要跨重启持久化。
alter table portfolio_state
  add column if not exists trading_halted boolean not null default false;
