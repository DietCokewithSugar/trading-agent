-- 033:估值看板(美股估值与情绪监控):每美东日一行的指标快照。
-- 用途:PE 历史分位与情绪指数的历史积累(外部估值/情绪接口只给当前值,
-- 「过去六个月 VIX 与 PE 分位」图的 PE 线随快照逐日补全;VIX 线由日线历史现算,不依赖本表)。
-- 观察层定位:不参与交易路径;表缺失时仅历史积累/图表 PE 线停用(一次告警),看板其余功能不受影响。
-- 管理重置有意保留(外部市场数据,与账本状态无关,沿 symbol_reference / backtest_analyses 先例)。

create table if not exists valuation_snapshots (
  id bigint generated always as identity primary key,
  snap_date date not null unique,     -- 美东日历日,每日收盘后一行(upsert)
  ndx_pe numeric,                     -- 纳指100 TTM PE(外部估值接口口径)
  ndx_pe_pct numeric,                 -- 纳指100 PE 历史分位(0–100)
  spx_pe numeric,                     -- 标普500 TTM PE
  spx_pe_pct numeric,                 -- 标普500 PE 历史分位(0–100)
  fear_greed numeric,                 -- 恐惧贪婪情绪指数(0–100)
  vix numeric,                        -- VIX 收盘水平
  created_at timestamptz not null default now()
);
create index if not exists idx_valuation_snapshots_date on valuation_snapshots (snap_date desc);
alter table valuation_snapshots enable row level security;
create policy "public read valuation_snapshots" on valuation_snapshots for select using (true);
