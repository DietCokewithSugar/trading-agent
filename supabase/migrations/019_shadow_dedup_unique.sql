-- 019:影子组合买入去重索引升级为唯一索引。
-- 017 建的是普通部分索引,不约束任何写入——"一变体一分析只买一次"的不变量
-- 此前只靠进程内串行队列的先查后插保证,进程重启丢队列或并发路径绕过时可能双买。
-- 升级前先清理已存在的重复行(每组保留最早一条;影子组合是纯观测层,
-- 留下的现金/持仓轻微残差由 admin reset 归零,可接受)。

delete from shadow_trades a
using shadow_trades b
where a.side = 'buy'
  and a.analysis_id is not null
  and b.side = 'buy'
  and b.analysis_id is not null
  and a.variant = b.variant
  and a.analysis_id = b.analysis_id
  and a.id > b.id;

drop index if exists idx_shadow_trades_buy_dedup;
create unique index if not exists idx_shadow_trades_buy_dedup on shadow_trades (variant, analysis_id)
  where side = 'buy' and analysis_id is not null;
