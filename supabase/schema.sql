-- 在 Supabase 控制台的 SQL Editor 中执行本文件,初始化数据库。

-- 新闻原文
create table if not exists news_articles (
  id bigint generated always as identity primary key,
  url text unique not null,
  title text not null,
  text_content text,
  source text,            -- fmp-stock / fmp-general / fmp-press / yahoo
  publisher text,
  image text,
  symbols text[] default '{}',
  published_at timestamptz,
  fetched_at timestamptz not null default now(),
  -- 非空表示已被分析过(含判定为不相关);为空的文章进入积压队列逐轮消化
  analyzed_at timestamptz
);
create index if not exists idx_news_published on news_articles (published_at desc);
create index if not exists idx_news_unanalyzed on news_articles (fetched_at) where analyzed_at is null;

-- DeepSeek 分析结果(利好/利空 + 四档)
create table if not exists news_analyses (
  id bigint generated always as identity primary key,
  news_id bigint not null references news_articles(id) on delete cascade,
  symbol text not null,
  company_name text,
  sentiment text not null check (sentiment in ('bullish', 'bearish', 'neutral')),
  -- 第1档=程度大范围大, 第2档=程度大范围小, 第3档=程度小范围大, 第4档=程度小范围小
  tier smallint check (tier between 1 and 4),
  impact_strength text check (impact_strength in ('high', 'low')),
  impact_scope text check (impact_scope in ('wide', 'narrow')),
  confidence numeric,
  reasoning text,
  model text,
  created_at timestamptz not null default now()
);
create index if not exists idx_analyses_news on news_analyses (news_id);
create index if not exists idx_analyses_symbol on news_analyses (symbol);

-- 模拟账户资金(单行)
create table if not exists portfolio_state (
  id smallint primary key default 1 check (id = 1),
  cash numeric not null,
  initial_capital numeric not null,
  updated_at timestamptz not null default now()
);

-- 当前持仓(止损/止盈价由 AI 在买入时设定,服务端自动监控触发)
create table if not exists positions (
  symbol text primary key,
  quantity numeric not null,
  avg_cost numeric not null,
  stop_loss numeric,
  take_profit numeric,
  peak_price numeric,           -- 建仓后的最高价,移动止损用(只升不降)
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 交易记录(含买卖原因与关联新闻)
create table if not exists trades (
  id bigint generated always as identity primary key,
  symbol text not null,
  side text not null check (side in ('buy', 'sell')),
  quantity numeric not null,
  price numeric not null,
  amount numeric not null,
  reason text,
  -- 触发来源:news=新闻信号, stop_loss=自动止损, take_profit=自动止盈
  trigger text not null default 'news',
  news_id bigint references news_articles(id) on delete set null,
  analysis_id bigint references news_analyses(id) on delete set null,
  realized_pnl numeric,
  -- 成交真实化(008):下单时点的市场参考价与施加的滑点(基点),price 为滑点后实际成交价
  quote_price numeric,
  slippage_bps numeric,
  created_at timestamptz not null default now()
);
create index if not exists idx_trades_created on trades (created_at desc);

-- 新闻事件:同一底层事件(同一公告/合作/财报)的多渠道报道归并为一条,
-- 事件级去重防止同一利好/利空被反复交易。
create table if not exists news_events (
  id bigint generated always as identity primary key,
  symbol text not null,
  sentiment text,
  summary text not null,            -- 事件概要(DeepSeek 提炼,跨媒体一致)
  article_count int not null default 1,  -- 归并到该事件的报道数
  traded boolean not null default false, -- 该事件是否已触发过交易
  trade_id bigint references trades(id) on delete set null,
  first_news_id bigint references news_articles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_events_symbol_created on news_events (symbol, created_at desc);

-- 分析结果关联事件 + 事件概要
alter table news_analyses add column if not exists event_id bigint references news_events(id) on delete set null;
alter table news_analyses add column if not exists event_summary text;

-- 组合净值快照(盈亏折线图)
create table if not exists portfolio_snapshots (
  id bigint generated always as identity primary key,
  cash numeric not null,
  positions_value numeric not null,
  total_value numeric not null,
  pnl numeric not null,
  pnl_percent numeric not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_snapshots_created on portfolio_snapshots (created_at);

-- 净值快照均匀采样(绕过 PostgREST 单次 1000 行上限,支撑长时间范围的折线图)
create or replace function snapshots_sampled(since timestamptz, max_points int default 600)
returns setof portfolio_snapshots
language sql stable as $$
  with filtered as (
    select s.*, row_number() over (order by created_at) as rn, count(*) over () as total
    from portfolio_snapshots s
    where created_at >= since
  )
  select id, cash, positions_value, total_value, pnl, pnl_percent, created_at
  from filtered
  where total <= max_points
     or rn % ceil(total::numeric / max_points)::int = 0
     or rn = total
  order by created_at;
$$;

-- 原子化交易:在单个事务里完成「现金增减 + 持仓变更 + 交易记录」,
-- 资金行/持仓行加行锁,消除服务端并发交易的现金读-改-写竞态。
create or replace function execute_trade(
  p_symbol text,
  p_side text,
  p_quantity numeric,
  p_price numeric,
  p_amount numeric,
  p_reason text default null,
  p_trigger text default 'news',
  p_news_id bigint default null,
  p_analysis_id bigint default null,
  p_stop_loss_percent numeric default null,
  p_take_profit_percent numeric default null
) returns trades
language plpgsql
as $$
declare
  v_cash numeric;
  v_pos positions%rowtype;
  v_new_qty numeric;
  v_new_avg numeric;
  v_realized numeric := null;
  v_trade trades;
begin
  -- 锁定资金行:并发交易在此串行,事务结束自动释放
  select cash into v_cash from portfolio_state where id = 1 for update;
  if not found then
    raise exception 'portfolio_state 未初始化';
  end if;

  if p_side = 'buy' then
    -- 留 1 美分容差:成交金额由四舍五入后的股数反算,临界全仓买入可能高出现金几厘
    if v_cash + 0.01 < p_amount then
      raise exception '现金不足:现有 %,买入需要 %', v_cash, p_amount;
    end if;
    update portfolio_state
      set cash = round(cash - p_amount, 2), updated_at = now()
      where id = 1;

    select * into v_pos from positions where symbol = p_symbol for update;
    if found then
      -- 加仓:加权平均成本,并按新的平均成本重设止损/止盈
      v_new_qty := round(v_pos.quantity + p_quantity, 4);
      v_new_avg := round((v_pos.quantity * v_pos.avg_cost + p_amount) / v_new_qty, 4);
      update positions set
        quantity = v_new_qty,
        avg_cost = v_new_avg,
        stop_loss = case when p_stop_loss_percent is not null
          then round(v_new_avg * (1 - p_stop_loss_percent / 100), 4) else stop_loss end,
        take_profit = case when p_take_profit_percent is not null
          then round(v_new_avg * (1 + p_take_profit_percent / 100), 4) else take_profit end,
        updated_at = now()
      where symbol = p_symbol;
    else
      v_new_avg := round(p_price, 4);
      insert into positions (symbol, quantity, avg_cost, stop_loss, take_profit)
      values (
        p_symbol, p_quantity, v_new_avg,
        case when p_stop_loss_percent is not null
          then round(v_new_avg * (1 - p_stop_loss_percent / 100), 4) end,
        case when p_take_profit_percent is not null
          then round(v_new_avg * (1 + p_take_profit_percent / 100), 4) end
      );
    end if;

  elsif p_side = 'sell' then
    select * into v_pos from positions where symbol = p_symbol for update;
    if not found then
      raise exception '未持有 %,无法卖出', p_symbol;
    end if;
    if v_pos.quantity < p_quantity - 0.0001 then
      raise exception '% 持仓不足:现有 %,试图卖出 %', p_symbol, v_pos.quantity, p_quantity;
    end if;

    update portfolio_state
      set cash = round(cash + p_amount, 2), updated_at = now()
      where id = 1;

    v_realized := round((p_price - v_pos.avg_cost) * p_quantity, 2);

    if v_pos.quantity - p_quantity <= 0.0001 then
      delete from positions where symbol = p_symbol;
    else
      update positions
        set quantity = round(v_pos.quantity - p_quantity, 4), updated_at = now()
        where symbol = p_symbol;
    end if;

  else
    raise exception '无效的交易方向: %', p_side;
  end if;

  insert into trades (symbol, side, quantity, price, amount, reason, trigger, news_id, analysis_id, realized_pnl)
  values (p_symbol, p_side, p_quantity, p_price, p_amount, p_reason, p_trigger, p_news_id, p_analysis_id, v_realized)
  returning * into v_trade;
  return v_trade;
end;
$$;

-- 该函数会改写资金与持仓,只允许服务端(service_role)调用
revoke all on function execute_trade(text, text, numeric, numeric, numeric, text, text, bigint, bigint, numeric, numeric) from public;
grant execute on function execute_trade(text, text, numeric, numeric, numeric, text, text, bigint, bigint, numeric, numeric) to service_role;

-- 管理后台全量数据重置:清空所有业务数据,现金恢复为初始资金。
-- truncate ... cascade 会一并清空引用这些表的从表(如 trade_reflections)。
-- security definer:restart identity 需要序列属主权限,必须以函数属主(postgres)身份执行
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

-- 交易记忆与反思(参考 FinMem/FinAgent:平仓后复盘,经验注入后续决策)
create table if not exists trade_reflections (
  id bigint generated always as identity primary key,
  trade_id bigint references trades(id) on delete set null,
  symbol text not null,
  trigger text,                 -- 平仓触发方式: news / stop_loss / take_profit / review
  entry_price numeric,          -- 持仓平均成本
  exit_price numeric,           -- 卖出价
  realized_pnl numeric,
  pnl_percent numeric,
  holding_minutes int,          -- 持有时长(分钟)
  thesis text,                  -- 原始买入论点(买入时的决策理由)
  outcome_summary text,         -- 结果复盘
  lesson text not null,         -- 经验教训(注入后续交易决策)
  importance numeric,           -- 0~1,检索排序用,亏损越大/教训越普适越高
  model text,
  created_at timestamptz not null default now()
);
create index if not exists idx_reflections_symbol on trade_reflections (symbol, created_at desc);

alter table trade_reflections enable row level security;
create policy "public read trade_reflections" on trade_reflections for select using (true);

-- 初始资金 10 万美元(服务端也会在缺失时自动初始化)
insert into portfolio_state (id, cash, initial_capital)
values (1, 100000, 100000)
on conflict (id) do nothing;

-- 启用 RLS 并允许匿名只读(服务端使用 service_role key 写入,不受 RLS 限制)
alter table news_articles enable row level security;
alter table news_analyses enable row level security;
alter table portfolio_state enable row level security;
alter table positions enable row level security;
alter table trades enable row level security;
alter table portfolio_snapshots enable row level security;
alter table news_events enable row level security;

create policy "public read news_articles" on news_articles for select using (true);
create policy "public read news_analyses" on news_analyses for select using (true);
create policy "public read portfolio_state" on portfolio_state for select using (true);
create policy "public read positions" on positions for select using (true);
create policy "public read trades" on trades for select using (true);
create policy "public read portfolio_snapshots" on portfolio_snapshots for select using (true);
create policy "public read news_events" on news_events for select using (true);
