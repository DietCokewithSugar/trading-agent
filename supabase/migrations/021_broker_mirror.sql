-- 021: 券商模拟对照账本
-- 实盘每笔成交镜像到外部券商的模拟账户(marketable 限价单,盘前盘后带 extended_hours),
-- 逐笔度量 成交价偏差(bps)与账户净值偏离,用真实撮合数据校准内部滑点模型。
-- 纯观测层:未配置券商 API key 或本迁移未执行时整体停用,绝不影响交易主链路。

create table if not exists broker_mirror_orders (
  id bigint generated always as identity primary key,
  trade_id bigint references trades(id) on delete set null,
  symbol text not null,
  side text not null check (side in ('buy', 'sell')),
  qty numeric not null,
  limit_price numeric,
  extended_hours boolean not null default false,
  -- 幂等键:trade-{trade_id},券商侧拒绝重复 client_order_id,防止重复镜像
  client_order_id text unique,
  broker_order_id text,
  -- submitted/partially_filled/filled/canceled/expired/rejected/skipped/error
  status text not null default 'submitted',
  filled_qty numeric,
  filled_avg_price numeric,
  internal_price numeric not null,   -- 内部账本成交价(偏差基准)
  -- 带方向的偏差:买入券商更贵为正、卖出券商更便宜为正 —— 正值 = 对我们不利
  diff_bps numeric,
  note text,
  submitted_at timestamptz not null default now(),
  filled_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_broker_mirror_orders_open
  on broker_mirror_orders (submitted_at)
  where status in ('submitted', 'partially_filled');
create index if not exists idx_broker_mirror_orders_recent
  on broker_mirror_orders (submitted_at desc);

-- 账户净值对照快照:券商模拟账户 equity/cash 与同时刻内部净值
create table if not exists broker_mirror_snapshots (
  id bigint generated always as identity primary key,
  equity numeric not null,
  cash numeric not null,
  internal_total_value numeric,
  created_at timestamptz not null default now()
);
create index if not exists idx_broker_mirror_snapshots_created
  on broker_mirror_snapshots (created_at desc);

-- RLS:与其它业务表一致,公开只读(无密钥、无供应商内部信息)
alter table broker_mirror_orders enable row level security;
alter table broker_mirror_snapshots enable row level security;
drop policy if exists "public read broker_mirror_orders" on broker_mirror_orders;
create policy "public read broker_mirror_orders" on broker_mirror_orders for select using (true);
drop policy if exists "public read broker_mirror_snapshots" on broker_mirror_snapshots;
create policy "public read broker_mirror_snapshots" on broker_mirror_snapshots for select using (true);
