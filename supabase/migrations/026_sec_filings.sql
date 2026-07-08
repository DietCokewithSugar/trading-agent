-- 026: SEC EDGAR 监管文件源(sec-filings 渠道)
-- 文章行携带监管文件元数据:source_type 标记来源类别(监管披露),
-- filing_form 记录表单类型(8-K / 8-K/A),filing_items 记录 8-K 重大事项条目编码。
-- url 仍为主文档链接,onConflict 去重键不变;未跑本迁移时服务端按逐列降级重试兼容。

alter table news_articles add column if not exists source_type text;    -- 'regulatory_filing'
alter table news_articles add column if not exists filing_form text;    -- '8-K' / '8-K/A'
alter table news_articles add column if not exists filing_items text[]; -- ['2.02','9.01']
