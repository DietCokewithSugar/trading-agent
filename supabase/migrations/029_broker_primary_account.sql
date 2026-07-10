-- 029: 券商模拟账户全面管理页化 —— 管理页可指定「主对照账户」(is_primary),
-- 它优先于 env 默认账户(ALPACA_KEY_ID/SECRET,自此降级为可选的遗留配置)承担
-- 展示主账本 / 券商对照卡 / 净值快照内部对比 的数据源职责。
-- 仅限用途为 mirror_actual 的账户可设为主对照账户(服务端校验);至多一个。

alter table broker_accounts add column if not exists is_primary boolean not null default false;
create unique index if not exists idx_broker_accounts_primary
  on broker_accounts (is_primary)
  where is_primary;
