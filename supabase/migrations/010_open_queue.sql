-- 010:开盘队列 — 休市时段产生的交易信号不再按上一收盘价立即成交,
-- 而是挂入 pending_orders,待下一个常规交易时段以当日开盘价(叠加盘中滑点)成交。
-- 隔夜新闻的跳空缺口由市场兑现,不再被模拟盘记成策略收益。
--
-- 数据重置:pending_orders 通过外键引用 trades/news_articles/news_analyses,
-- admin_reset_data 的 truncate ... cascade 会自动一并清空,无需改函数。

create table if not exists pending_orders (
  id bigint generated always as identity primary key,
  symbol text not null,
  side text not null check (side in ('buy', 'sell')),
  -- buy: 动用组合总值的比例(已含档位/置信度/来源/风控官缩放);sell: 卖出持仓比例
  fraction numeric not null,
  ref_price numeric,                  -- 决策时参考价(休市 stale 价,仅供审计对比跳空)
  stop_loss_percent numeric,
  take_profit_percent numeric,
  reason text,
  news_id bigint references news_articles(id) on delete set null,
  analysis_id bigint references news_analyses(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'filled', 'cancelled', 'expired')),
  trade_id bigint references trades(id) on delete set null,
  note text,                          -- 终态说明(成交/作废原因)
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists idx_pending_orders_pending on pending_orders (created_at)
  where status = 'pending';

alter table pending_orders enable row level security;
create policy "public read pending_orders" on pending_orders for select using (true);
