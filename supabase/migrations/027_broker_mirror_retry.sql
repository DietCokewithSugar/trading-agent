-- 027: 券商镜像单未成交跟进(顺延 / 重挂 / 对账清理)
-- 021 的镜像单为当日限价单,过期即永久放弃:卖单未成交会在券商账户滞留孤儿持仓,
-- 买单未成交则券商侧永远没建仓,两个账本永久分歧。本迁移为重挂机制加记账列:
--  - 休市时段镜像单不再直接提交,落 status='deferred' 待开盘以实时价挂单;
--  - 在途单迁移到 expired/canceled/rejected 且有余量时,按策略生成子行重挂
--    (卖单限价重试耗尽后升级市价单保证收敛;买单限时追单,漂移超限记 status='abandoned');
--  - 对账清理行不加专列:靠 trade_id is null + client_order_id like 'reconcile-%' 识别。
-- status 为无约束 text,新状态(deferred/abandoned)无需迁移;仅重挂链需要下面两列。

-- 第几次尝试(1 = 首挂);子行 = 父行 attempt + 1
alter table broker_mirror_orders add column if not exists attempt int not null default 1;
-- 重挂链:指向被本行接替的上一次尝试(统计时被引用的未成交终态行记"已重挂"而非"未成交")
alter table broker_mirror_orders add column if not exists retry_of bigint references broker_mirror_orders(id) on delete set null;

-- 在途单部分索引补上 deferred(轮询工作集:submitted/partially_filled/deferred)
drop index if exists idx_broker_mirror_orders_open;
create index if not exists idx_broker_mirror_orders_open
  on broker_mirror_orders (submitted_at)
  where status in ('submitted', 'partially_filled', 'deferred');
