-- 022: 候选池同票合并 —— 同票多事件不再各插一行,合并进已有活跃候选
--(截图问题:TSLA 两条不同利好间隔 2 分钟各插一行,池里同票重复显示)。
-- merged_events 持久记录共振事件数(allocator#mergeBySymbol 的加成依据,
-- 入池即合并后同票只剩一行,内存合并的"组内行数"不再反映真实事件数);
-- last_signal_at 是时效衰减/续命的新锚点(缺失回退 created_at,旧行兼容)。

alter table candidate_signals add column if not exists merged_events integer not null default 1;
alter table candidate_signals add column if not exists last_signal_at timestamptz;

-- 清理存量重复活跃行:每票保留最早入池的一行(entry_price/created_at 排队成本锚点),
-- 该行吸收组内最强兄弟(base_score 最高)的信号字段与事件计数,其余行取消
--(共振加成由 merged_events 延续,与代码侧合并语义一致)
with dup as (
  select id, symbol,
         row_number() over (partition by symbol order by created_at asc, id asc) as rn,
         count(*) over (partition by symbol) as cnt
  from candidate_signals
  where status in ('pending','capital_constrained','conflict_hold','macro_filtered')
), best as (
  select distinct on (symbol) symbol, news_id, analysis_id, event_id, tier, confidence,
         final_confidence, source_score, sector, base_score, current_score, created_at as sig_at
  from candidate_signals
  where status in ('pending','capital_constrained','conflict_hold','macro_filtered')
  order by symbol, base_score desc nulls last, created_at desc
)
update candidate_signals c
set news_id = b.news_id, analysis_id = b.analysis_id, event_id = b.event_id,
    tier = b.tier, confidence = b.confidence, final_confidence = b.final_confidence,
    source_score = b.source_score, sector = b.sector,
    base_score = b.base_score, current_score = b.current_score,
    merged_events = greatest(c.merged_events, d.cnt),
    last_signal_at = b.sig_at, updated_at = now()
from dup d, best b
where c.id = d.id and d.rn = 1 and d.cnt > 1 and b.symbol = c.symbol;

with dup as (
  select id, row_number() over (partition by symbol order by created_at asc, id asc) as rn
  from candidate_signals
  where status in ('pending','capital_constrained','conflict_hold','macro_filtered')
)
update candidate_signals c
set status = 'cancelled', status_reason = '同票候选合并(022 清理)', updated_at = now()
from dup d where c.id = d.id and d.rn > 1;

-- 同票同时最多一个活跃候选(019 影子买入去重同款硬约束;代码侧捕 23505 归并降级)
create unique index if not exists idx_candidate_signals_active_symbol_unique
  on candidate_signals (symbol)
  where status in ('pending','capital_constrained','conflict_hold','macro_filtered');
