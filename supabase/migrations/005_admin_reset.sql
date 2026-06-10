-- 005: 管理后台全量数据重置
-- 在单个事务里清空所有业务数据,并把现金恢复为初始资金。
-- truncate ... cascade 会一并清空引用这些表的从表(如后续迁移新增的 trade_reflections)。

-- security definer:truncate ... restart identity 需要序列属主权限,
-- service_role 并不拥有这些序列,必须以函数属主(postgres)身份执行
create or replace function admin_reset_data(p_initial_capital numeric default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_capital numeric;
begin
  truncate table
    trades,
    news_events,
    news_analyses,
    news_articles,
    portfolio_snapshots,
    positions
  restart identity cascade;

  -- 优先用调用方传入的初始资金(来自服务端 INITIAL_CAPITAL 配置),否则沿用账户原值
  select coalesce(p_initial_capital, initial_capital) into v_capital
  from portfolio_state where id = 1;
  if not found then
    v_capital := coalesce(p_initial_capital, 100000);
    insert into portfolio_state (id, cash, initial_capital)
    values (1, v_capital, v_capital);
  else
    update portfolio_state
      set cash = v_capital, initial_capital = v_capital, updated_at = now()
      where id = 1;
  end if;
end;
$$;

-- 该函数会清空全部数据且以属主身份执行,只允许服务端(service_role)调用
revoke all on function admin_reset_data(numeric) from public;
revoke all on function admin_reset_data(numeric) from anon;
revoke all on function admin_reset_data(numeric) from authenticated;
grant execute on function admin_reset_data(numeric) to service_role;
