-- 014: 宏观信号层 + 候选池 + 组合化资金分配
-- 1) macro_events:无个股指向的宏观新闻经 LLM 分类后的事件流(CPI/FOMC/关税/地缘政治等),
--    供代码侧时间衰减聚合出当前市场环境(macro regime);
-- 2) macro_state:单行当前宏观状态(risk_on/neutral/risk_off/macro_shock + 利率/通胀/增长子标签),
--    持久化保证重启后状态延续;
-- 3) candidate_signals:买入候选池 —— 可交易的利好信号不再先到先得地即时成交,
--    而是入池统一打分排序,由资金分配器(盘中每 N 分钟一轮 + 开盘首跑)按分数高低分配资金;
--    没钱执行的机会标记 capital_constrained 留池复评,信号本身仍参与前瞻收益评估;
-- 4) trades.macro_regime:成交时的宏观状态快照,供前端展示与复盘。

create table if not exists macro_events (
  id bigint generated always as identity primary key,
  news_id bigint references news_articles(id) on delete set null,
  -- 事件类型:CPI/PPI/FOMC/NFP/GDP/yields/tariffs/geopolitics/energy/fiscal/other
  event_type text not null,
  macro_direction text not null check (macro_direction in ('risk_on', 'risk_off', 'neutral')),
  -- 实际值 vs 预期值(经济日历匹配时回填数值;方向由 LLM 从文中判断)
  surprise numeric,
  surprise_direction text check (surprise_direction in ('positive', 'negative', 'inline', 'unknown')),
  rates_signal text check (rates_signal in ('hawkish', 'dovish', 'neutral')),
  inflation_signal text check (inflation_signal in ('up', 'down', 'neutral')),
  growth_signal text check (growth_signal in ('up', 'down', 'neutral')),
  -- [{ "sector": "Technology", "direction": "bearish" }, ...]
  affected_sectors jsonb not null default '[]'::jsonb,
  -- 1=全市场级 2=多行业级 3=情绪/噪音级
  market_impact_tier smallint not null check (market_impact_tier between 1 and 3),
  confidence numeric,
  summary text,
  created_at timestamptz not null default now()
);
create index if not exists idx_macro_events_created on macro_events (created_at desc);

alter table macro_events enable row level security;
create policy "public read macro_events" on macro_events for select using (true);

-- 当前宏观状态(单行,id=1):由近 72 小时 macro_events 时间衰减加权聚合得出
create table if not exists macro_state (
  id smallint primary key default 1 check (id = 1),
  regime text not null default 'neutral'
    check (regime in ('risk_on', 'neutral', 'risk_off', 'macro_shock')),
  risk_score numeric not null default 0,        -- [-1,1] 连续风险偏好分
  rates_signal text,
  inflation_signal text,
  growth_signal text,
  shock_until timestamptz,                       -- macro_shock 到期时间(到期自动解除)
  updated_at timestamptz not null default now()
);
insert into macro_state (id) values (1) on conflict (id) do nothing;

alter table macro_state enable row level security;
create policy "public read macro_state" on macro_state for select using (true);

-- 买入候选池:状态机
--   pending=待分配  allocated=已成交  capital_constrained=资金受限(留池复评)
--   macro_filtered=宏观过滤(留池复评)  conflict_hold=多空冲突搁置(留池复评)
--   rejected=已拒绝(LLM hold/风控否决/准入失败)  expired=超时过期  cancelled=已取消
create table if not exists candidate_signals (
  id bigint generated always as identity primary key,
  symbol text not null,
  side text not null default 'buy' check (side in ('buy')),
  news_id bigint references news_articles(id) on delete set null,
  analysis_id bigint references news_analyses(id) on delete set null,
  event_id bigint references news_events(id) on delete set null,
  tier smallint,
  sentiment text,
  confidence numeric,
  final_confidence numeric,
  source_score numeric,
  sector text,
  base_score numeric,                            -- 入池时的初始分
  current_score numeric,                         -- 最近一次分配轮刷新的分(含时效衰减/宏观乘数)
  macro_regime text,                             -- 入池时宏观状态快照(评估层分桶用)
  status text not null default 'pending' check (status in
    ('pending', 'allocated', 'capital_constrained', 'macro_filtered',
     'conflict_hold', 'rejected', 'expired', 'cancelled')),
  status_reason text,
  trade_id bigint references trades(id) on delete set null,
  expires_at timestamptz,
  last_evaluated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_candidate_signals_active on candidate_signals (created_at)
  where status in ('pending', 'capital_constrained', 'conflict_hold', 'macro_filtered');
create index if not exists idx_candidate_signals_symbol on candidate_signals (symbol)
  where status in ('pending', 'capital_constrained', 'conflict_hold', 'macro_filtered');

alter table candidate_signals enable row level security;
create policy "public read candidate_signals" on candidate_signals for select using (true);

-- 成交时的宏观状态快照(recordFillDetails best-effort 补写)
alter table trades add column if not exists macro_regime text;

-- 每轮运行新增计数:入池候选数 / 宏观事件数(saveCycleRun strip-and-retry 兼容旧库)
alter table cycle_runs add column if not exists pooled integer not null default 0;
alter table cycle_runs add column if not exists macro_events integer not null default 0;

-- 重发 admin_reset_data:truncate 列表加入 macro_events / candidate_signals,
-- 并把 macro_state 复位为 neutral(其余与 012 一致)
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
    cycle_runs,
    macro_events,
    candidate_signals
  restart identity cascade;

  -- 宏观状态复位(单行表不 truncate,避免丢失行)
  update macro_state
    set regime = 'neutral', risk_score = 0,
        rates_signal = null, inflation_signal = null, growth_signal = null,
        shock_until = null, updated_at = now()
    where id = 1;

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
