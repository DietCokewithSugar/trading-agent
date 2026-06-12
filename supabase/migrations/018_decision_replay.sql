-- 018: LLM 交易决策可回放
-- 每次交易员决策(decideTrade)连同风控官审批(reviewProposedTrade)落一行完整记录:
-- prompt 版本号、发给模型的完整 messages(可直接重放)、输入快照哈希、LLM 原始返回、
-- 解析钳制后的 normalized 结果、仓位缩放链各步、决策价/成交价快照与最终结局。
-- 没有这层,改 prompt 或换模型后无法区分收益变化来自市场随机、prompt 还是模型。
-- 纯观测层:服务端 fail-open,表缺失时静默停用,交易主链路不受影响。
create table if not exists trade_decisions (
  id bigint generated always as identity primary key,
  symbol text not null,
  -- 决策路径:immediate=即时交易路径(候选池不可用/利空卖出),allocation=分配器路径
  path text not null check (path in ('immediate', 'allocation')),
  run_id uuid,
  news_id bigint references news_articles(id) on delete set null,
  analysis_id bigint references news_analyses(id) on delete set null,
  candidate_id bigint references candidate_signals(id) on delete set null,
  trade_id bigint references trades(id) on delete set null,
  model text,
  -- 交易员(decideTrade)
  trader_prompt_version integer,
  trader_messages jsonb,        -- 完整 prompt(system+user,可原样重放)
  trader_input_hash text,       -- sha256(trader_messages):同输入对比不同 prompt/模型用
  trader_raw jsonb,             -- LLM 原始返回 JSON
  trader_decision jsonb,        -- 解析钳制后的 normalized decision
  trader_latency_ms integer,
  -- 风控官(reviewProposedTrade;未启用/未走到时为空)
  officer_prompt_version integer,
  officer_messages jsonb,
  officer_input_hash text,
  officer_raw jsonb,
  officer_verdict jsonb,
  officer_latency_ms integer,
  -- 仓位缩放链各步(llm_fraction → 档位/置信/来源 → 冲突 → 连亏 → 风控官 → final)
  sizing jsonb,
  -- 价格快照与结局
  decision_price numeric,       -- decideTrade 时参考价
  fill_price numeric,           -- 成交价(滑点后;成交时回填)
  fill_quote_price numeric,     -- 成交时市场参考价(滑点前)
  -- executed / queued / hold / symbol_invalid / vetoed / officer_error / rejected / sell_skipped
  outcome text not null,
  outcome_reason text,
  created_at timestamptz not null default now()
);
create index if not exists idx_trade_decisions_created on trade_decisions (created_at desc);
create index if not exists idx_trade_decisions_symbol on trade_decisions (symbol, created_at desc);

-- RLS:启用但不开放匿名读(沿 cycle_runs 先例)——完整 prompt 含组合明细、
-- 历史教训等内部信息,只经 token 门控的管理接口(/api/admin/decisions)暴露
alter table trade_decisions enable row level security;

-- admin_reset_data 重建:truncate 列表加入 trade_decisions
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
    trade_decisions
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
