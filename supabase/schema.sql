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
-- 人工交易暂停开关(013):开启后只拦新开买入,所有卖出/止损/止盈/复查照常
alter table portfolio_state add column if not exists trading_halted boolean not null default false;

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
-- 持仓时限(020):opened_at 老库可能缺列(此前从无迁移补过);hold_refreshed_at 为
-- 最近一次"持有依据刷新"时间(买入成交或同票新利好事件),持有期限 = 该值(缺失回退
-- opened_at)+ MAX_HOLD_HOURS,到期由风控循环全仓卖出(trigger='max_hold')
alter table positions add column if not exists opened_at timestamptz not null default now();
alter table positions add column if not exists hold_refreshed_at timestamptz not null default now();

-- 交易记录(含买卖原因与关联新闻)
create table if not exists trades (
  id bigint generated always as identity primary key,
  symbol text not null,
  side text not null check (side in ('buy', 'sell')),
  quantity numeric not null,
  price numeric not null,
  amount numeric not null,
  reason text,
  -- 触发来源:news=新闻信号, stop_loss=自动止损, take_profit=自动止盈, review=每日持仓复查
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

-- 新闻来源可信度(009):文章记录原始来源域名与可信度评分,
-- 分析记录综合置信度(来源 × 置信度 × 时效 × 档位),事件记录独立信源域名用于交叉确认
alter table news_articles add column if not exists source_domain text;
alter table news_articles add column if not exists source_score numeric;
alter table news_analyses add column if not exists final_confidence numeric;
alter table news_events add column if not exists source_domains text[] not null default '{}';

-- 信号前瞻收益(011,评估层):每条非中性分析记录信号时点市场价,
-- 后台任务回填 1 小时 / 1 交易日 / 5 交易日前瞻收益(百分比,相对 signal_price),
-- 覆盖未实际交易的信号,用于评估分类信号本身的命中率/IC/校准(/api/signal-stats)
alter table news_analyses add column if not exists signal_price numeric;
alter table news_analyses add column if not exists fwd_return_1h numeric;
alter table news_analyses add column if not exists fwd_return_1d numeric;
alter table news_analyses add column if not exists fwd_return_5d numeric;
create index if not exists idx_analyses_fwd_pending on news_analyses (created_at)
  where signal_price is not null and (fwd_return_1d is null or fwd_return_5d is null);

-- 可观测性与执行时间线(012):分析行关联运行 + LLM 调用明细,
-- 交易行关联运行 + 决策窗口(decideTrade 调用前 → 风控官审批结束)+ 成交报价自带时间戳
alter table news_analyses add column if not exists run_id uuid;
alter table news_analyses add column if not exists llm_latency_ms integer;
alter table news_analyses add column if not exists llm_prompt_tokens integer;
alter table news_analyses add column if not exists llm_completion_tokens integer;
alter table trades add column if not exists run_id uuid;
alter table trades add column if not exists decision_started_at timestamptz;
alter table trades add column if not exists decision_finished_at timestamptz;
alter table trades add column if not exists quote_timestamp timestamptz;

-- 每轮运行指标(012):runCycle 的计数/耗时/LLM 用量/错误/拒绝原因落库,供管理页复盘
create table if not exists cycle_runs (
  run_id uuid primary key,
  -- 触发来源:scheduler=内置调度, manual=公开手动触发接口, admin=管理后台
  trigger_source text not null default 'scheduler'
    check (trigger_source in ('scheduler', 'manual', 'admin')),
  full_fetch boolean not null default false,
  started_at timestamptz not null,
  finished_at timestamptz,
  duration_ms integer,
  new_articles integer not null default 0,
  analyzed integer not null default 0,
  signals integer not null default 0,
  deduped integer not null default 0,
  held integer not null default 0,
  queued integer not null default 0,
  trades integer not null default 0,
  -- 本轮完整错误文本(可能包含上游供应商名称,只经 token 门控的管理接口暴露)
  errors jsonb not null default '[]'::jsonb,
  llm_calls integer not null default 0,
  llm_prompt_tokens integer not null default 0,
  llm_completion_tokens integer not null default 0,
  llm_cost numeric,                                   -- 估算成本(美元,按配置单价折算)
  fmp_errors integer not null default 0,
  deepseek_errors integer not null default 0,
  reject_reasons jsonb not null default '{}'::jsonb,  -- { 拒绝原因: 次数 }
  created_at timestamptz not null default now()
);
create index if not exists idx_cycle_runs_started on cycle_runs (started_at desc);

-- 宏观信号层 + 候选池(014):
-- macro_events 记录无个股指向的宏观新闻分类结果;macro_state 单行持久化当前宏观环境;
-- candidate_signals 是买入候选池 —— 利好信号不再先到先得即时成交,而是入池统一打分,
-- 由资金分配器(盘中每 N 分钟一轮 + 开盘首跑)按分数高低分配资金。
create table if not exists macro_events (
  id bigint generated always as identity primary key,
  news_id bigint references news_articles(id) on delete set null,
  -- 事件类型:CPI/PPI/FOMC/NFP/GDP/yields/tariffs/geopolitics/energy/fiscal/other
  event_type text not null,
  macro_direction text not null check (macro_direction in ('risk_on', 'risk_off', 'neutral')),
  -- 实际值 vs 预期值(经济日历匹配时回填数值;方向由 LLM 从文中判断)
  surprise numeric,
  surprise_direction text check (surprise_direction in ('positive', 'negative', 'inline', 'unknown')),
  rates_signal text check (rates_signal in ('hawkish', 'dovish', 'neutral')),
  inflation_signal text check (inflation_signal in ('up', 'down', 'neutral')),
  growth_signal text check (growth_signal in ('up', 'down', 'neutral')),
  -- [{ "sector": "Technology", "direction": "bearish" }, ...]
  affected_sectors jsonb not null default '[]'::jsonb,
  -- 1=全市场级 2=多行业级 3=情绪/噪音级
  market_impact_tier smallint not null check (market_impact_tier between 1 and 3),
  confidence numeric,
  summary text,
  -- 归并的报道篇数(015):同一宏观事件的重复报道只累计篇数,不插新行
  article_count integer not null default 1,
  created_at timestamptz not null default now(),
  -- 最近一次归并时间(015);created_at 保持首报时点,时间衰减与有效期均以首报为准
  updated_at timestamptz not null default now()
);
create index if not exists idx_macro_events_created on macro_events (created_at desc);

-- 当前宏观状态(单行,id=1):由近 72 小时 macro_events 时间衰减加权聚合得出
create table if not exists macro_state (
  id smallint primary key default 1 check (id = 1),
  regime text not null default 'neutral'
    check (regime in ('risk_on', 'neutral', 'risk_off', 'macro_shock')),
  risk_score numeric not null default 0,        -- [-1,1] 连续风险偏好分
  rates_signal text,
  inflation_signal text,
  growth_signal text,
  shock_until timestamptz,                       -- macro_shock 到期时间(到期自动解除)
  updated_at timestamptz not null default now()
);
insert into macro_state (id) values (1) on conflict (id) do nothing;

-- 买入候选池:状态机
--   pending=待分配  allocated=已成交  capital_constrained=资金受限(留池复评)
--   macro_filtered=宏观过滤(留池复评)  conflict_hold=多空冲突搁置(留池复评)
--   rejected=已拒绝(LLM hold/风控否决/准入失败)  expired=超时过期  cancelled=已取消
create table if not exists candidate_signals (
  id bigint generated always as identity primary key,
  symbol text not null,
  side text not null default 'buy' check (side in ('buy')),
  news_id bigint references news_articles(id) on delete set null,
  analysis_id bigint references news_analyses(id) on delete set null,
  event_id bigint references news_events(id) on delete set null,
  tier smallint,
  sentiment text,
  confidence numeric,
  final_confidence numeric,
  source_score numeric,
  sector text,
  base_score numeric,                            -- 入池时的初始分
  current_score numeric,                         -- 最近一次分配轮刷新的分(含时效衰减/宏观乘数)
  macro_regime text,                             -- 入池时宏观状态快照(评估层分桶用)
  status text not null default 'pending' check (status in
    ('pending', 'allocated', 'capital_constrained', 'macro_filtered',
     'conflict_hold', 'rejected', 'expired', 'cancelled')),
  status_reason text,
  trade_id bigint references trades(id) on delete set null,
  expires_at timestamptz,
  last_evaluated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_candidate_signals_active on candidate_signals (created_at)
  where status in ('pending', 'capital_constrained', 'conflict_hold', 'macro_filtered');
create index if not exists idx_candidate_signals_symbol on candidate_signals (symbol)
  where status in ('pending', 'capital_constrained', 'conflict_hold', 'macro_filtered');

-- 成交时的宏观状态快照(014,recordFillDetails best-effort 补写)
alter table trades add column if not exists macro_regime text;

-- 每轮运行新增计数(014):入池候选数 / 宏观事件数
alter table cycle_runs add column if not exists pooled integer not null default 0;
alter table cycle_runs add column if not exists macro_events integer not null default 0;

-- 每轮运行新增计数(020):同票利好刷新(刷新持有时钟+上抬止盈,不产生交易)的次数
alter table cycle_runs add column if not exists refreshed integer not null default 0;

-- 开盘队列(010):休市时段产生的交易信号挂单,待下一常规时段以开盘价成交,
-- 隔夜跳空由市场兑现而不是被模拟盘白捡
create table if not exists pending_orders (
  id bigint generated always as identity primary key,
  symbol text not null,
  side text not null check (side in ('buy', 'sell')),
  -- buy: 动用组合总值的比例(已含档位/置信度/来源/风控官缩放);sell: 卖出持仓比例
  fraction numeric not null,
  ref_price numeric,                  -- 决策时参考价(休市 stale 价,仅供审计对比跳空)
  stop_loss_percent numeric,
  take_profit_percent numeric,
  reason text,
  news_id bigint references news_articles(id) on delete set null,
  analysis_id bigint references news_analyses(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'filled', 'cancelled', 'expired')),
  trade_id bigint references trades(id) on delete set null,
  note text,                          -- 终态说明(成交/作废原因)
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists idx_pending_orders_pending on pending_orders (created_at)
  where status = 'pending';

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

-- 执行质量度量 + 宏观信源可信度 + 复盘基准(016):
-- candidate_signals.entry_price 记录入池时市场价;trades.pool_* 记录候选池路径的
-- 排队成本(入池价/等待分钟/入池→成交漂移);macro_events 记录来源可信度与独立信源
-- 域名集合(eventWeight 乘来源分,macro_shock 触发需多篇报道或多个独立信源佐证);
-- trade_reflections 记录同期 SPY 基准(复盘按超额收益评判,而非绝对盈亏)
alter table candidate_signals add column if not exists entry_price numeric;
alter table trades add column if not exists pool_entry_price numeric;
alter table trades add column if not exists pool_wait_minutes integer;
alter table trades add column if not exists pool_drift_percent numeric;
alter table macro_events add column if not exists source_domain text;
alter table macro_events add column if not exists source_score numeric;
alter table macro_events add column if not exists source_domains jsonb not null default '[]'::jsonb;
alter table trade_reflections add column if not exists spy_return_percent numeric;
alter table trade_reflections add column if not exists excess_return_percent numeric;

-- 影子组合 / 消融实验(017):与实盘并行记账的多套虚拟组合,每套关闭一层防线
-- (风控官/宏观过滤/候选池/LLM 仓位),外加 SPY 买入持有与纯现金基准,
-- 用事后净值对比回答"哪一层真的贡献收益,哪一层只是减少交易"。纯观测层,
-- 表缺失时服务端自动停用,交易主链路不受影响。变体见 shadow_portfolios.variant 注释(017 迁移)。
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
-- 同一变体对同一条分析最多买一次(防宏观过滤逐轮重放/留池候选后续真实成交导致的重复买入);
-- 唯一索引(019):数据库级硬约束,进程内先查后插只是第一道防线
create unique index if not exists idx_shadow_trades_buy_dedup on shadow_trades (variant, analysis_id)
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

-- LLM 交易决策可回放(018):每次交易员决策连同风控官审批落一行完整记录
-- (prompt 版本、完整 messages、输入哈希、原始返回、normalized 结果、缩放链、价格快照、结局),
-- 改 prompt/换模型后可用旧输入重放对比。RLS 不开放匿名读(完整 prompt 含内部信息,
-- 只经 token 门控的 /api/admin/decisions 暴露)。
create table if not exists trade_decisions (
  id bigint generated always as identity primary key,
  symbol text not null,
  path text not null check (path in ('immediate', 'allocation')),
  run_id uuid,
  news_id bigint references news_articles(id) on delete set null,
  analysis_id bigint references news_analyses(id) on delete set null,
  candidate_id bigint references candidate_signals(id) on delete set null,
  trade_id bigint references trades(id) on delete set null,
  model text,
  trader_prompt_version integer,
  trader_messages jsonb,
  trader_input_hash text,
  trader_raw jsonb,
  trader_decision jsonb,
  trader_latency_ms integer,
  officer_prompt_version integer,
  officer_messages jsonb,
  officer_input_hash text,
  officer_raw jsonb,
  officer_verdict jsonb,
  officer_latency_ms integer,
  sizing jsonb,
  decision_price numeric,
  fill_price numeric,
  fill_quote_price numeric,
  outcome text not null,
  outcome_reason text,
  created_at timestamptz not null default now()
);
create index if not exists idx_trade_decisions_created on trade_decisions (created_at desc);
create index if not exists idx_trade_decisions_symbol on trade_decisions (symbol, created_at desc);

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
alter table pending_orders enable row level security;
-- 例外:cycle_runs 启用 RLS 但不开放匿名读 —— errors 中会出现上游供应商名称,
-- 按约定供应商信息只允许出现在 token 门控的管理面(/api/admin/metrics);
-- 服务端使用 service_role key,不受 RLS 限制
alter table cycle_runs enable row level security;
-- trade_decisions 同理:完整 prompt 含组合明细等内部信息,启用 RLS 但不开放匿名读
alter table trade_decisions enable row level security;
alter table macro_events enable row level security;
alter table macro_state enable row level security;
alter table candidate_signals enable row level security;
alter table shadow_portfolios enable row level security;
alter table shadow_positions enable row level security;
alter table shadow_trades enable row level security;
alter table shadow_snapshots enable row level security;

create policy "public read news_articles" on news_articles for select using (true);
create policy "public read news_analyses" on news_analyses for select using (true);
create policy "public read portfolio_state" on portfolio_state for select using (true);
create policy "public read positions" on positions for select using (true);
create policy "public read trades" on trades for select using (true);
create policy "public read portfolio_snapshots" on portfolio_snapshots for select using (true);
create policy "public read news_events" on news_events for select using (true);
create policy "public read pending_orders" on pending_orders for select using (true);
create policy "public read macro_events" on macro_events for select using (true);
create policy "public read macro_state" on macro_state for select using (true);
create policy "public read candidate_signals" on candidate_signals for select using (true);
create policy "public read shadow_portfolios" on shadow_portfolios for select using (true);
create policy "public read shadow_positions" on shadow_positions for select using (true);
create policy "public read shadow_trades" on shadow_trades for select using (true);
create policy "public read shadow_snapshots" on shadow_snapshots for select using (true);
