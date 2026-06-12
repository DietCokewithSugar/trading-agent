-- 017: 影子组合 / 消融实验
-- 与实盘并行记账的多套虚拟组合,每套关闭一层防线(风控官/宏观过滤/候选池/LLM 仓位),
-- 外加 SPY 买入持有与纯现金基准,用事后净值对比回答"哪一层真的贡献收益,哪一层只是减少交易"。
-- 纯观测层:服务端 fail-open,表缺失时影子组合整体停用,交易主链路不受影响。

-- 每套影子组合一行:variant 为变体标识
--   no_risk_officer  跟随实盘,但风控官否决/缩仓的买入按否决前方案照样执行
--   no_macro_filter  跟随实盘,但被宏观层(regime 过滤/冲击/黑窗/预算钳制)拦截的买入照样执行
--   immediate_trade  独立组合:可交易利好信号到达即按确定性仓位买入,不经候选池/LLM 决策
--   equal_weight     独立组合:可交易信号一律等权固定比例买入,检验 LLM 仓位是否有效
--   spy_benchmark    启用时一次性全仓买入 SPY 并持有
--   cash             纯现金基准
create table if not exists shadow_portfolios (
  variant text primary key,
  cash numeric not null,
  initial_capital numeric not null,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists shadow_positions (
  variant text not null references shadow_portfolios(variant) on delete cascade,
  symbol text not null,
  quantity numeric not null,
  avg_cost numeric not null,
  stop_loss numeric,
  take_profit numeric,
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (variant, symbol)
);

create table if not exists shadow_trades (
  id bigint generated always as identity primary key,
  variant text not null,
  symbol text not null,
  side text not null check (side in ('buy', 'sell')),
  quantity numeric not null,
  price numeric not null,
  amount numeric not null,
  reason text,
  -- news=信号 / stop_loss / take_profit / review=镜像复查卖出 / benchmark=基准建仓
  trigger text not null default 'news',
  realized_pnl numeric,
  -- 镜像自实盘成交时的源交易(消融变体跟随实盘的部分)
  mirror_trade_id bigint references trades(id) on delete set null,
  news_id bigint references news_articles(id) on delete set null,
  analysis_id bigint references news_analyses(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_shadow_trades_variant on shadow_trades (variant, created_at desc);
-- 同一变体对同一条分析最多买一次(防宏观过滤逐轮重放/留池候选后续真实成交导致的重复买入)
create index if not exists idx_shadow_trades_buy_dedup on shadow_trades (variant, analysis_id)
  where side = 'buy' and analysis_id is not null;

create table if not exists shadow_snapshots (
  id bigint generated always as identity primary key,
  variant text not null,
  cash numeric not null,
  positions_value numeric not null,
  total_value numeric not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_shadow_snapshots_variant on shadow_snapshots (variant, created_at);

-- 影子净值序列的均匀采样(全部变体一次取回,绕过 PostgREST 单次 1000 行上限)
create or replace function shadow_snapshots_sampled(p_since timestamptz, p_max_points int default 300)
returns setof shadow_snapshots
language sql stable as $$
  with filtered as (
    select s.*,
           row_number() over (partition by variant order by created_at) as rn,
           count(*) over (partition by variant) as total
    from shadow_snapshots s
    where created_at >= p_since
  )
  select id, variant, cash, positions_value, total_value, created_at
  from filtered
  where total <= p_max_points
     or rn % ceil(total::numeric / p_max_points)::int = 0
     or rn = total
  order by variant, created_at;
$$;

-- RLS:公共只读(无供应商信息;reason 为决策理由文本,与 trades.reason 同口径)
alter table shadow_portfolios enable row level security;
alter table shadow_positions enable row level security;
alter table shadow_trades enable row level security;
alter table shadow_snapshots enable row level security;
create policy "public read shadow_portfolios" on shadow_portfolios for select using (true);
create policy "public read shadow_positions" on shadow_positions for select using (true);
create policy "public read shadow_trades" on shadow_trades for select using (true);
create policy "public read shadow_snapshots" on shadow_snapshots for select using (true);

-- admin_reset_data 重建:truncate 列表加入影子组合表(shadow_portfolios cascade 清空
-- shadow_positions;服务端重置后会自动重新初始化各变体)
create or replace function admin_reset_data(p_initial_capital numeric default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_capital numeric;
begin
  -- cascade 会一并清空 trade_reflections / pending_orders 等引用这些表的从表
  truncate table
    trades,
    news_events,
    news_analyses,
    news_articles,
    portfolio_snapshots,
    positions,
    cycle_runs,
    macro_events,
    candidate_signals,
    shadow_portfolios,
    shadow_trades,
    shadow_snapshots
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
