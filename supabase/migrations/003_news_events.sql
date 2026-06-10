-- 已有部署请在 Supabase SQL Editor 执行本文件;新部署直接执行最新的 schema.sql 即可。

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

alter table news_events enable row level security;
create policy "public read news_events" on news_events for select using (true);
