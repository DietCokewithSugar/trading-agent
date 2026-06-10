-- 006: 交易记忆与反思(参考 FinMem/FinAgent:平仓后复盘,经验注入后续决策)
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
