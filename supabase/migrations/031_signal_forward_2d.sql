-- 031:前瞻收益新增 2 个交易日口径(≈48 小时,与 ±2%/48h 持有上限对齐的决策口径)。
-- 5d 口径在 48h 强制离场的策略下与实盘盈亏几乎无关,且成熟期 ≥7 天导致按时间倒序的
-- 采样窗口内几乎没有已回填样本(结构性饥饿)——停止回填与展示,改为 2d。
-- fwd_return_5d 列保留(历史数据不破坏,仅休眠);回填待办索引改按 1d/2d 判定,
-- 否则永远填不上的 5d 会把全部行钉死在部分索引里。

alter table news_analyses add column if not exists fwd_return_2d numeric;

drop index if exists idx_analyses_fwd_pending;
create index idx_analyses_fwd_pending on news_analyses (created_at)
  where signal_price is not null and (fwd_return_1d is null or fwd_return_2d is null);
