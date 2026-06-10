-- 已有部署请在 Supabase SQL Editor 执行本文件;新部署直接执行最新的 schema.sql 即可。

-- 止损/止盈价(买入时由 AI 设定,服务端自动监控触发)
alter table positions add column if not exists stop_loss numeric;
alter table positions add column if not exists take_profit numeric;

-- 交易触发来源:news=新闻信号, stop_loss=自动止损, take_profit=自动止盈
alter table trades add column if not exists trigger text not null default 'news';

-- 净值快照均匀采样(绕过 PostgREST 单次 1000 行上限,支撑长时间范围的折线图)
create or replace function snapshots_sampled(since timestamptz, max_points int default 600)
returns setof portfolio_snapshots
language sql stable as $$
  with filtered as (
    select s.*, row_number() over (order by created_at) as rn, count(*) over () as total
    from portfolio_snapshots s
    where created_at >= since
  )
  select id, cash, positions_value, total_value, pnl, pnl_percent, created_at
  from filtered
  where total <= max_points
     or rn % ceil(total::numeric / max_points)::int = 0
     or rn = total
  order by created_at;
$$;
