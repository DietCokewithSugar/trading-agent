-- 025: 腾位孪生变体(纯代码,无需建表——影子四表变体通用)+ 多券商模拟账户。
-- broker_accounts 存账户凭据:RLS 开启且**不建公开读策略**(secret 绝不可公开,
-- 与 trade_decisions 同级;服务端 service_role 全权,管理接口只回传脱敏字段)。
-- 每个账户的 purpose 决定它镜像谁:mirror_actual=实盘;影子变体名=该变体的
-- 影子买卖以 marketable 限价单镜像到该账户(真实 NBBO 撮合);unassigned=闲置。

create table if not exists broker_accounts (
  id bigint generated always as identity primary key,
  label text not null,
  key_id text not null,
  secret_key text not null,
  purpose text not null default 'unassigned',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table broker_accounts enable row level security;

-- 对照单/快照归属账户(null = env 配置的默认账户)与来源变体(null = 实盘)
alter table broker_mirror_orders add column if not exists account_id bigint references broker_accounts(id) on delete set null;
alter table broker_mirror_orders add column if not exists source_variant text;
alter table broker_mirror_snapshots add column if not exists account_id bigint references broker_accounts(id) on delete set null;
