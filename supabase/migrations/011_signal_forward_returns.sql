-- 011:信号前瞻收益(评估层)— 每条非中性分析记录信号时点市场价,
-- 后台任务回填三个口径的前瞻收益(百分比,相对 signal_price):
--   fwd_return_1h  信号后 1~2 小时窗口内的最新有效价(休市窗口错过则保持空);
--   fwd_return_1d  信号日(美东)之后第 1 个交易日收盘价;
--   fwd_return_5d  信号日之后第 5 个交易日收盘价。
-- 覆盖包括被去重/挂起而未实际交易的信号,用于评估"分类信号本身"的
-- 方向命中率 / IC / 置信度校准(/api/signal-stats),与组合表现解耦。

alter table news_analyses add column if not exists signal_price numeric;
alter table news_analyses add column if not exists fwd_return_1h numeric;
alter table news_analyses add column if not exists fwd_return_1d numeric;
alter table news_analyses add column if not exists fwd_return_5d numeric;

create index if not exists idx_analyses_fwd_pending on news_analyses (created_at)
  where signal_price is not null and (fwd_return_1d is null or fwd_return_5d is null);
