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
  fetched_at timestamptz not null default now()
);
create index if not exists idx_news_published on news_articles (published_at desc);

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
