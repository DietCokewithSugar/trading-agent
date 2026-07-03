-- 023: 出场策略层 —— 出场规则消融变体 + 波动自适应敞口。
-- 出场规则(±2%/48h)此前是全系统唯一没被消融的层:三个新镜像影子变体
-- (wide_bracket ±4%/96h、trailing_only 仅移动止损、vol_bracket 波动自适应对照)
-- 度量它;实盘侧支持按 20 日已实现波动缩放 bracket(clamp(k×vol, 1.5%, 4%)),
-- 默认关闭,由管理员页运行时开关控制(不走环境变量)。

-- trailing_only 影子变体的移动止损棘轮锚点(实盘 positions.peak_price 的影子对应,007 同款语义)
alter table shadow_positions add column if not exists peak_price numeric;

-- 每笔买入的 bracket 宽度与波动快照(recordFillDetails best-effort 补写):
-- 统计层跨票归一的依据——固定 ±2% 下不同波动的票 bracket 实际不是同一个东西
alter table trades add column if not exists stop_loss_percent numeric;
alter table trades add column if not exists take_profit_percent numeric;
alter table trades add column if not exists bracket_vol numeric;            -- 20 日已实现日波动(%),开关关闭时也记录

-- 波动自适应敞口运行时开关(013 trading_halted 同款持久化;管理页切换,重启保持)
alter table portfolio_state add column if not exists vol_bracket_enabled boolean not null default false;
