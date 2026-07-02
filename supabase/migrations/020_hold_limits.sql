-- 020: 持仓时限(强制平仓)与同票利好刷新
-- 交易频率改造:持仓最长 MAX_HOLD_HOURS(默认 48h),同票新利好(一/二档、经事件去重)
-- 刷新持有时钟并上抬止盈线;到期由风控循环以 trigger='max_hold' 全仓卖出。

-- positions.opened_at 在 schema.sql 中早已存在,但从未有迁移补过——老库可能缺列
alter table positions add column if not exists opened_at timestamptz not null default now();

-- 最近一次"持有依据刷新"时间:任何买入成交或同票新利好事件都会刷新,
-- 持有期限 = hold_refreshed_at(缺失回退 opened_at)+ MAX_HOLD_HOURS。
-- 存量持仓自迁移时刻起算(default now())
alter table positions add column if not exists hold_refreshed_at timestamptz not null default now();

-- 每轮运行新增计数:同票利好刷新(刷新时钟+上抬止盈,不产生交易)的次数
alter table cycle_runs add column if not exists refreshed integer not null default 0;
