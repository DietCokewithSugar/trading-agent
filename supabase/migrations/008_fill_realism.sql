-- 008:模拟成交真实化 — 在 trades 上记录成交时点的市场参考价与施加的滑点。
-- price 为滑点后的实际成交价;quote_price 为下单时的最新市场价;
-- slippage_bps 为本笔施加的滑点(基点),便于事后审计执行成本。
alter table trades add column if not exists quote_price numeric;
alter table trades add column if not exists slippage_bps numeric;
