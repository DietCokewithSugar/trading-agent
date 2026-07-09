-- 028: 标的名录(交易所上市目录镜像)+ 新闻筛选索引
-- symbol_reference:官方上市目录的每日/盘中镜像,进程内 Map 的重启暖表与审计来源;
-- 准入门用它做名录存在性/测试标的/财务异常状态/ETF/交易所的确定性校验。
-- 表缺失时服务端只停 DB 镜像,进程内名录照常工作(迁移容忍)。

create table if not exists symbol_reference (
  symbol text primary key,          -- 归一后代码('.'→'-',与报价源一致)
  security_name text,
  exchange text,                    -- 归一短代码:NASDAQ/NYSE/AMEX/ARCA/BATS/IEX
  market_category text,             -- NASDAQ 上市层级(Q/G/S),其他交易所为 null
  is_etf boolean,
  is_test_issue boolean,
  financial_status text,            -- N/D/E/Q/G/H/J/K,仅 NASDAQ 上市有
  round_lot integer,
  listing_source text,              -- 'nasdaq' | 'other'
  updated_at timestamptz not null default now()
);
alter table symbol_reference enable row level security;
create policy "public read symbol_reference" on symbol_reference for select using (true);

-- 新闻筛选(服务端过滤):跨日期代码包含查询(q 搜索的 symbols.cs 路径)走 GIN;
-- 方向/档位驱动的 news_analyses inner join 子查询走复合索引。
-- 日期/游标路径复用既有 idx_news_published,symbol 精确筛选复用既有 idx_analyses_symbol
create index if not exists idx_news_symbols_gin on news_articles using gin (symbols);
create index if not exists idx_analyses_sentiment_tier on news_analyses (sentiment, tier);
