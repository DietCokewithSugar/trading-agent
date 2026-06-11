-- 015: 宏观事件去重归并 —— 同一宏观事件的重复报道归并到原行,
-- 防止 regime 风险分被重复报道线性叠加放大。
-- article_count: 归并的报道篇数;updated_at: 最近一次归并时间。
-- created_at 保持首报时点不变:时间衰减与 72h 有效期均以首报为准,
-- 重复报道不"续命"——持续发酵的事件会有实质性新进展,由 LLM 判为新事件自然续上权重。
alter table macro_events add column if not exists article_count integer not null default 1;
alter table macro_events add column if not exists updated_at timestamptz not null default now();
