-- 004: 交易原子化 + 新闻分析积压队列
--
-- 1) execute_trade():在单个数据库事务里完成「现金增减 + 持仓变更 + 交易记录」,
--    并对资金行/持仓行加行锁,消除服务端「读组合 → JS 算新现金 → 写回」的并发竞态
--    (新闻交易与止损监控并发时,后写会覆盖前写的现金变动)。
-- 2) news_articles.analyzed_at:标记文章已被分析(含判定为不相关),
--    让超过每轮分析上限(MAX_ANALYZE_PER_CYCLE)的文章进入积压队列逐轮消化,
--    而不是被永久丢弃。

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

-- 该函数会改写资金与持仓,只允许服务端(service_role)调用,
-- 禁止持有匿名 key 的客户端通过 PostgREST 直接触发
revoke all on function execute_trade(text, text, numeric, numeric, numeric, text, text, bigint, bigint, numeric, numeric) from public;
grant execute on function execute_trade(text, text, numeric, numeric, numeric, text, text, bigint, bigint, numeric, numeric) to service_role;

-- 新闻分析积压队列:analyzed_at 非空表示已分析过(含判定为不相关)
alter table news_articles add column if not exists analyzed_at timestamptz;
create index if not exists idx_news_unanalyzed on news_articles (fetched_at) where analyzed_at is null;

-- 存量数据回填:已有分析记录的文章标记为已分析,避免迁移后被重复分析
update news_articles a
  set analyzed_at = a.fetched_at
  where a.analyzed_at is null
    and exists (select 1 from news_analyses n where n.news_id = a.id);
