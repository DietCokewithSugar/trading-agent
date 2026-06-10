-- 009: 新闻来源可信度
-- 文章记录原始来源域名与可信度评分(对"原始新闻来源"打分,FMP/Yahoo 只是抓取渠道);
-- 分析记录综合置信度(来源可信度 × 分析置信度 × 时效 × 事件档位);
-- 事件记录已出现的独立信源域名,低可信信号挂起后由独立信源交叉确认放行。

alter table news_articles add column if not exists source_domain text;
alter table news_articles add column if not exists source_score numeric;

alter table news_analyses add column if not exists final_confidence numeric;

alter table news_events add column if not exists source_domains text[] not null default '{}';
