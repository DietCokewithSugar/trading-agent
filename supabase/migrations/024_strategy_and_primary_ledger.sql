-- 024: 主账户交易策略运行时选择 + 券商模拟账本展示主账本切换。
-- 策略选择器取代 023 的 vol_bracket_enabled 布尔开关(列保留、代码不再读写,回滚兼容);
-- broker_ledger_primary 只切换展示层数据源(仪表盘主视图),内部引擎账本与交易链路不变。
-- trading_strategy 不加 CHECK 约束:预设清单由代码校验,未来加预设无需再迁移。

alter table portfolio_state add column if not exists trading_strategy text not null default 'default';
alter table portfolio_state add column if not exists broker_ledger_primary boolean not null default false;

-- 回填:已开启波动自适应敞口的部署映射为 vol_bracket 策略(行为无缝衔接)
update portfolio_state
  set trading_strategy = 'vol_bracket'
  where vol_bracket_enabled = true and trading_strategy = 'default';
