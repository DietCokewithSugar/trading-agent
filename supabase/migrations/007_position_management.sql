-- 007: 持仓管理 — 移动止损所需的峰值价
-- 股价创新高后,止损价按买入时的止损距离跟随上抬(只升不降),锁住浮盈
alter table positions add column if not exists peak_price numeric;
