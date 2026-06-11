-- 012: 可观测性与执行时间线
-- 1) cycle_runs:每轮 runCycle 的运行指标落库(计数/耗时/LLM 用量/错误/拒绝原因),
--    管理页据此展示最近运行与排障数据;
-- 2) news_analyses / trades 增加 run_id 关联与时间线字段,
--    完整还原"决策时系统看到了什么",为未来回测保留时间游标。

create table if not exists cycle_runs (
  run_id uuid primary key,
  -- 触发来源:scheduler=内置调度, manual=公开手动触发接口, admin=管理后台
  trigger_source text not null default 'scheduler'
    check (trigger_source in ('scheduler', 'manual', 'admin')),
  full_fetch boolean not null default false,
  started_at timestamptz not null,
  finished_at timestamptz,
  duration_ms integer,
  new_articles integer not null default 0,
  analyzed integer not null default 0,
  signals integer not null default 0,
  deduped integer not null default 0,
  held integer not null default 0,
  queued integer not null default 0,
  trades integer not null default 0,
  -- 本轮完整错误文本(可能包含上游供应商名称,只经 token 门控的管理接口暴露)
  errors jsonb not null default '[]'::jsonb,
  llm_calls integer not null default 0,
  llm_prompt_tokens integer not null default 0,
  llm_completion_tokens integer not null default 0,
  llm_cost numeric,                                   -- 估算成本(美元,按配置单价折算)
  fmp_errors integer not null default 0,
  deepseek_errors integer not null default 0,
  reject_reasons jsonb not null default '{}'::jsonb,  -- { 拒绝原因: 次数 }
  created_at timestamptz not null default now()
);
create index if not exists idx_cycle_runs_started on cycle_runs (started_at desc);

-- 例外:本表启用 RLS 但不开放匿名读 —— errors 中会出现上游供应商名称,
-- 按约定供应商信息只允许出现在 token 门控的管理面(/api/admin/metrics);
-- 服务端使用 service_role key,不受 RLS 限制。
alter table cycle_runs enable row level security;

-- 分析行:关联运行 + LLM 调用明细(时延/用量)
alter table news_analyses add column if not exists run_id uuid;
alter table news_analyses add column if not exists llm_latency_ms integer;
alter table news_analyses add column if not exists llm_prompt_tokens integer;
alter table news_analyses add column if not exists llm_completion_tokens integer;

-- 交易行:关联运行 + 决策窗口(decideTrade 调用前 → 风控官审批结束,
-- 即"决策依据价格的失效窗口",漂移熔断防的正是这段时间)+ 成交所用报价自带的时间戳
alter table trades add column if not exists run_id uuid;
alter table trades add column if not exists decision_started_at timestamptz;
alter table trades add column if not exists decision_finished_at timestamptz;
alter table trades add column if not exists quote_timestamp timestamptz;

-- 重发 admin_reset_data:truncate 列表加入 cycle_runs(其余与 005 一致)
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
    positions,
    cycle_runs
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

revoke all on function admin_reset_data(numeric) from public;
revoke all on function admin_reset_data(numeric) from anon;
revoke all on function admin_reset_data(numeric) from authenticated;
grant execute on function admin_reset_data(numeric) to service_role;
