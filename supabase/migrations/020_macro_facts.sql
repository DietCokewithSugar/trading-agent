-- 020: 宏观事实层(macro_facts)—— 把「宏观事件」而非「新闻文章」作为风险计量的唯一单位。
--
-- 背景:此前 regime 风险分聚合自 macro_events(每篇文章一行,靠 015 的 LLM 判重 + 016 的
-- 组内几何衰减防止重复报道线性放大)。本迁移把单位上移到「事实」:一次 CPI 发布就是一个
-- 事件(event_key=CPI_2026-05),不管被 1 篇还是 20 篇新闻报道,只贡献一次风险分。
--
-- 两条写入路径都汇入 macro_facts:
--   1) 经济日历:high-importance 美国数据出 actual 后,按 event_key upsert 数值事实
--      (actual/estimate/previous/surprise + has_actual),CPI/PPI/PCE/FOMC 由意外幅度
--      确定性推出方向(数据事实层,不依赖新闻解释);
--   2) 宏观新闻:先按确定性 event_key(周期性数据)或 LLM 判重(地缘/能源等非周期)link
--      到已有事实,命中只累计 source_count / 增信 / 累加独立信源,未命中才新建——
--      新闻是叙事层,为事实补充方向/行业/置信度。
--
-- 风险分从 macro_facts 聚合(macroRegime.aggregateRegime 复用);has_actual 的日历事实
-- 自身即硬证据,满足 macro_shock 佐证门。迁移容忍:未执行 020 时整体回退 macro_events 路径。
create table if not exists macro_facts (
  id bigint generated always as identity primary key,
  -- 唯一事件键:周期性数据按类型+美东年月(CPI_2026-05 / FOMC_2026-06);
  -- 非周期事件按类型+美东日+序号(geopolitics_2026-06-15_1)
  event_key text not null unique,
  event_type text not null,
  macro_direction text not null default 'neutral'
    check (macro_direction in ('risk_on', 'risk_off', 'neutral')),
  -- 数值事实(经济日历回填;纯新闻事件无数值时为 null)
  actual numeric,
  estimate numeric,
  previous numeric,
  surprise numeric,                              -- 相对/绝对意外幅度(computeSurprise)
  surprise_score numeric,                        -- 归一化意外强度 → eventWeight 乘数(缺省 1)
  surprise_direction text check (surprise_direction in ('positive', 'negative', 'inline', 'unknown')),
  rates_signal text check (rates_signal in ('hawkish', 'dovish', 'neutral')),
  inflation_signal text check (inflation_signal in ('up', 'down', 'neutral')),
  growth_signal text check (growth_signal in ('up', 'down', 'neutral')),
  affected_sectors jsonb not null default '[]'::jsonb,
  market_impact_tier smallint not null default 3 check (market_impact_tier between 1 and 3),
  confidence numeric,
  summary text,
  has_actual boolean not null default false,     -- 经济日历实际值已出(硬证据,自带 shock 佐证)
  release_time timestamptz,                       -- 日历计划/实际发布时刻
  source_count integer not null default 0,       -- 关联新闻报道篇数(日历独建为 0)
  source_domain text,                            -- 首个新闻来源域名
  source_score numeric,                          -- 历来最高来源可信度
  source_domains jsonb not null default '[]'::jsonb,  -- 独立信源域名集合(shock 佐证用)
  first_news_id bigint references news_articles(id) on delete set null,
  created_at timestamptz not null default now(), -- 首次出现(时间衰减与有效期基准)
  updated_at timestamptz not null default now()
);
create index if not exists idx_macro_facts_created on macro_facts (created_at desc);

alter table macro_facts enable row level security;
create policy "public read macro_facts" on macro_facts for select using (true);
