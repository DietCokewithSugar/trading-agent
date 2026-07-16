-- 032:策略回测(参照 TradingAgents 论文的验证方法):
-- 用户选定标的 + 历史窗口,LLM 重析历史新闻得到「AI 新闻策略」曲线,
-- 与经典基线(买入持有 / MACD / KDJ+RSI / ZMR 零均值回归 / SMA 双均线)对比,
-- 输出 CR% / 年化 / 夏普 / 最大回撤 / 交易次数 / 胜率。
-- 观察层定位:两张表均不参与交易路径;表缺失时服务端回测功能整体停用(一次告警)。

-- 回测运行记录:params/progress/result 全走 jsonb(结果曲线点数有上限,见服务端截断);
-- error 经 sanitizeProviderText 清洗(公开读表,不得出现供应商名)。
create table if not exists backtest_runs (
  id uuid primary key,                       -- 服务端 randomUUID 生成(沿 cycle_runs.run_id 先例)
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'cancelled')),
  params jsonb not null,                     -- {symbols, from, to, cost_bps, thresholds, strategy_params}
  progress jsonb,                            -- {phase, symbol, analyzed, total}
  result jsonb,                              -- 完成后:逐标的 {signals, strategies:{ai|buy_hold|macd|kdj_rsi|zmr|sma}}
  error text,                                -- 失败原因(已脱敏)
  llm_calls integer not null default 0,
  llm_prompt_tokens bigint not null default 0,
  llm_completion_tokens bigint not null default 0,
  llm_cost_usd numeric,                      -- 按配置单价估算
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists idx_backtest_runs_created on backtest_runs (created_at desc);
alter table backtest_runs enable row level security;
create policy "public read backtest_runs" on backtest_runs for select using (true);

-- 逐文章分析缓存:同一 (url, 查询标的, prompt 版本) 只花一次 LLM 钱,重跑/重叠窗口直接命中。
-- 管理重置保留(昂贵的外部派生缓存,沿 symbol_reference 先例);analyst prompt 文本变更时
-- 必须 bump deepseek.js#PROMPT_VERSIONS.analyst,旧版本行自然失效(键不再命中)。
create table if not exists backtest_analyses (
  id bigint generated always as identity primary key,
  url text not null,
  symbol text not null,                      -- 查询标的(prompt 输入的一部分,与 analysis_symbol 可能不同)
  prompt_version smallint not null,
  published_at timestamptz,
  title text,
  source text,                               -- 归一来源渠道(fmp-stock 等)
  source_domain text,
  source_score numeric,
  publisher text,
  relevant boolean,
  analysis_symbol text,                      -- 分析师认定的新闻主体代码(可能≠查询标的,回放时不一致即丢弃)
  sentiment text,
  tier smallint,
  confidence numeric,
  reasoning text,
  llm_prompt_tokens integer,
  llm_completion_tokens integer,
  llm_latency_ms integer,
  created_at timestamptz not null default now(),
  unique (url, symbol, prompt_version)       -- 缓存命中键
);
create index if not exists idx_backtest_analyses_lookup on backtest_analyses (symbol, published_at);
alter table backtest_analyses enable row level security;
create policy "public read backtest_analyses" on backtest_analyses for select using (true);

-- 重发 admin_reset_data:truncate 列表加 backtest_runs(回测运行记录随业务数据清空);
-- backtest_analyses 有意不清 —— 它是对外部历史新闻的分析缓存,与账本状态无关,重建代价高。
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
    shadow_snapshots,
    trade_decisions,
    backtest_runs
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
