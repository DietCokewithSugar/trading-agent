-- 016: 执行质量度量 + 宏观信源可信度 + 复盘基准
-- 1) candidate_signals.entry_price:入池时刻市场价,度量候选池"排队成本"
--    (信号→成交的价格漂移与等待时长);
-- 2) trades.pool_*:候选池路径成交的排队度量(入池价/等待分钟/价格漂移百分比),
--    recordFillDetails best-effort 补写,旧库逐列降级;
-- 3) macro_events 来源可信度与独立信源:eventWeight 乘入来源分;
--    macro_shock 触发需 ≥2 篇报道或 ≥2 个独立信源佐证(单源单篇不再硬触发);
-- 4) trade_reflections 同期 SPY 基准:复盘按超额收益(alpha)评判,而非绝对盈亏(beta)。

alter table candidate_signals add column if not exists entry_price numeric;

alter table trades add column if not exists pool_entry_price numeric;
alter table trades add column if not exists pool_wait_minutes integer;
alter table trades add column if not exists pool_drift_percent numeric;

alter table macro_events add column if not exists source_domain text;
alter table macro_events add column if not exists source_score numeric;
-- 独立信源域名集合(归并重复报道时累加;判定 macro_shock 佐证用)
alter table macro_events add column if not exists source_domains jsonb not null default '[]'::jsonb;

alter table trade_reflections add column if not exists spy_return_percent numeric;
alter table trade_reflections add column if not exists excess_return_percent numeric;
