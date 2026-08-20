-- 034:新闻分析的板块归属(SPDR 行业 ETF 口径:XLK/XLV/XLF/XLY/XLC/XLI/XLP/XLE/XLU/XLRE/XLB)
-- 存的是数据源原始行业名(与 candidate_signals.sector 同口径),归一到 ETF 板块在代码里
-- 完成(server/services/sectors.js)——数据源改名只改别名表,历史数据不用迁移。
-- 分析入库时按分析主体的公司档案写入;历史行由 sectorService 的回填任务逐批补齐
-- (公司档案取不到行业的标的——ETF/基金/退市——留空,进未分类桶)。

alter table news_analyses add column if not exists sector text;

-- 按板块筛选新闻 / 板块情绪看板聚合
create index if not exists idx_analyses_sector on news_analyses (sector, created_at desc)
  where sector is not null;
-- 回填待办队列:按时间倒序找还没有板块的分析行;取不到行业的标的会长期留在索引里,
-- 但这类标的数量有界(进程内冷却表避免反复重取),不会像 031 的 5d 那样把全表钉住
create index if not exists idx_analyses_sector_pending on news_analyses (created_at desc)
  where sector is null;
