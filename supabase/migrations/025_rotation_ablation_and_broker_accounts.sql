-- 025: 腾位对照影子变体 + 多券商模拟账户
--
-- 一、腾位对照组(*_rotation 影子变体)无需模式变更:shadow_portfolios.variant 为自由文本,
--    服务端启动时自动补建资金行。新变体(与本体同源同参,唯一差异是现金不足时先全仓止盈
--    "最接近止盈价的盈利持仓"再重试买入):
--      no_risk_officer_rotation / no_macro_filter_rotation / wide_bracket_rotation /
--      trailing_only_rotation / vol_bracket_rotation / equal_weight_rotation
--    (immediate_trade 的腾位对照沿用 024 的 immediate_rotation)
--
-- 二、多券商模拟账户(broker_accounts):管理员页可添加多个券商模拟账户(API key),
--    并给每个账户指派一个消融变体——该变体此后每笔影子成交以 marketable 限价单发往
--    对应账户,用真实盘口撮合复演消融实验(与 021 的实盘对照账本同一套观测层约定:
--    fire-and-forget、fail-open、client_order_id 幂等)。

create table if not exists broker_accounts (
  id bigint generated always as identity primary key,
  name text not null,
  key_id text not null,
  secret_key text not null,
  base_url text,                 -- 为空时用服务端默认(官方模拟盘端点)
  -- 用途:null = 闲置;影子变体名 = 该变体的每笔影子成交发往本账户真实撮合
  purpose text,
  enabled boolean not null default true,
  status text,                   -- 最近一次连通性校验结果:ok / error
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 同一用途(变体)最多绑定一个启用中的账户
create unique index if not exists idx_broker_accounts_purpose_unique
  on broker_accounts (purpose) where enabled and purpose is not null;

create table if not exists broker_account_orders (
  id bigint generated always as identity primary key,
  account_id bigint not null references broker_accounts(id) on delete cascade,
  shadow_trade_id bigint references shadow_trades(id) on delete set null,
  variant text,
  symbol text not null,
  side text not null check (side in ('buy', 'sell')),
  qty numeric not null,
  limit_price numeric,
  extended_hours boolean not null default false,
  -- 幂等键:shadow-{shadow_trade_id},券商侧拒绝重复 client_order_id,防止重复执行
  client_order_id text unique,
  broker_order_id text,
  -- submitted/partially_filled/filled/canceled/expired/rejected/skipped/error
  status text not null default 'submitted',
  filled_qty numeric,
  filled_avg_price numeric,
  internal_price numeric not null,   -- 影子账本成交价(偏差基准)
  -- 带方向的偏差:买入券商更贵为正、卖出券商更便宜为正 —— 正值 = 对影子账本不利
  diff_bps numeric,
  note text,
  submitted_at timestamptz not null default now(),
  filled_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_broker_account_orders_open
  on broker_account_orders (submitted_at)
  where status in ('submitted', 'partially_filled');
create index if not exists idx_broker_account_orders_account
  on broker_account_orders (account_id, submitted_at desc);

-- 账户净值快照:券商模拟账户 equity/cash 与同时刻该变体的影子净值
create table if not exists broker_account_snapshots (
  id bigint generated always as identity primary key,
  account_id bigint not null references broker_accounts(id) on delete cascade,
  variant text,
  equity numeric not null,
  cash numeric not null,
  shadow_total_value numeric,
  created_at timestamptz not null default now()
);
create index if not exists idx_broker_account_snapshots_account
  on broker_account_snapshots (account_id, created_at desc);

-- RLS:broker_accounts 存有 API 密钥,启用 RLS 且【不建】公共读策略
-- (仅 service_role 可达;管理面接口输出前脱敏,secret 永不返回)——
-- 与 cycle_runs/trade_decisions 同一例外先例。orders/snapshots 不含密钥,公共只读与 021 一致。
alter table broker_accounts enable row level security;
alter table broker_account_orders enable row level security;
alter table broker_account_snapshots enable row level security;
drop policy if exists "public read broker_account_orders" on broker_account_orders;
create policy "public read broker_account_orders" on broker_account_orders for select using (true);
drop policy if exists "public read broker_account_snapshots" on broker_account_snapshots;
create policy "public read broker_account_snapshots" on broker_account_snapshots for select using (true);
