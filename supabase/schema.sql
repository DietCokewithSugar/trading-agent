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

-- 当前持仓
create table if not exists positions (
  symbol text primary key,
  quantity numeric not null,
  avg_cost numeric not null,
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
  news_id bigint references news_articles(id) on delete set null,
  analysis_id bigint references news_analyses(id) on delete set null,
  realized_pnl numeric,
  created_at timestamptz not null default now()
);
create index if not exists idx_trades_created on trades (created_at desc);

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

create policy "public read news_articles" on news_articles for select using (true);
create policy "public read news_analyses" on news_analyses for select using (true);
create policy "public read portfolio_state" on portfolio_state for select using (true);
create policy "public read positions" on positions for select using (true);
create policy "public read trades" on trades for select using (true);
create policy "public read portfolio_snapshots" on portfolio_snapshots for select using (true);
