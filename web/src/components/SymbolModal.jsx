import React, { useEffect, useState } from 'react';
import {
  api,
  fmtMoney,
  fmtNum,
  fmtPercent,
  fmtTime,
  TIER_LABELS,
  SESSION_LABELS,
  TRIGGER_LABELS,
} from '../api.js';

/** 股票详情弹层:报价(含盘前盘后)、持仓、相关新闻分析、交易历史 */
export default function SymbolModal({ symbol, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    setError(null);
    api.symbol(symbol).then(setData).catch((err) => setError(err.message));
  }, [symbol]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const quote = data?.quote;
  const position = data?.position;
  const price = quote?.effective_price ?? quote?.price;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>
            {symbol}
            {quote?.name && <span className="muted modal-name"> {quote.name}</span>}
          </h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {error && <p className="empty">⚠️ {error}</p>}
        {!data && !error && <p className="empty">加载中…</p>}

        {data && (
          <>
            {quote ? (
              <div className="quote-head">
                <span className="quote-price">{fmtMoney(price)}</span>
                {quote.session && quote.session !== 'regular' && (
                  <span className="badge badge-session">{SESSION_LABELS[quote.session]}</span>
                )}
                <span className={quote.changesPercentage >= 0 ? 'up' : 'down'}>
                  今日 {fmtPercent(quote.changesPercentage)}
                </span>
                {quote.extended_price !== null && quote.extended_change_percent !== null && (
                  <span className={quote.extended_change_percent >= 0 ? 'up' : 'down'}>
                    {SESSION_LABELS[quote.session] || '盘后'} {fmtPercent(quote.extended_change_percent)}
                  </span>
                )}
              </div>
            ) : (
              <p className="empty">暂无报价数据</p>
            )}

            {position && (
              <div className="modal-section">
                <h3>当前持仓</h3>
                <p className="small">
                  {fmtNum(position.quantity, 4)} 股 · 成本 {fmtMoney(position.avg_cost)}
                  {position.stop_loss && <> · 止损 {fmtMoney(position.stop_loss)}</>}
                  {position.take_profit && <> · 止盈 {fmtMoney(position.take_profit)}</>}
                  {price && (
                    <>
                      {' · 浮动盈亏 '}
                      <span className={price >= position.avg_cost ? 'up' : 'down'}>
                        {fmtMoney((price - position.avg_cost) * position.quantity)}
                      </span>
                    </>
                  )}
                </p>
              </div>
            )}

            <div className="modal-section">
              <h3>相关新闻分析 ({data.analyses.length})</h3>
              {!data.analyses.length ? (
                <p className="empty">暂无该股票的分析记录。</p>
              ) : (
                <ul className="news-list">
                  {data.analyses.map((a) => (
                    <li key={a.id} className="modal-item">
                      <span
                        className={`badge ${
                          a.sentiment === 'bullish'
                            ? 'badge-bull'
                            : a.sentiment === 'bearish'
                              ? 'badge-bear'
                              : 'badge-neutral'
                        }`}
                      >
                        {a.sentiment === 'bullish' ? '利好' : a.sentiment === 'bearish' ? '利空' : '中性'}
                        {a.tier ? ` · ${TIER_LABELS[a.tier]}` : ''}
                      </span>
                      <span className="muted small"> {fmtTime(a.created_at)}</span>
                      {a.news_articles && (
                        <p className="small">
                          <a href={a.news_articles.url} target="_blank" rel="noreferrer">
                            {a.news_articles.title}
                          </a>
                        </p>
                      )}
                      {a.reasoning && <p className="reason">🧠 {a.reasoning}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="modal-section">
              <h3>交易历史 ({data.trades.length})</h3>
              {!data.trades.length ? (
                <p className="empty">暂无该股票的交易记录。</p>
              ) : (
                <ul className="news-list">
                  {data.trades.map((t) => (
                    <li key={t.id} className="modal-item">
                      <span className={`badge ${t.side === 'buy' ? 'badge-buy' : 'badge-sell'}`}>
                        {t.side === 'buy' ? '买入' : '卖出'}
                      </span>
                      {TRIGGER_LABELS[t.trigger] && (
                        <span className="badge badge-trigger">{TRIGGER_LABELS[t.trigger]}</span>
                      )}
                      <span className="small">
                        {' '}{fmtNum(t.quantity, 4)} 股 @ {fmtMoney(t.price)}
                      </span>
                      {t.realized_pnl !== null && (
                        <span className={`small ${Number(t.realized_pnl) >= 0 ? 'up' : 'down'}`}>
                          {' '}盈亏 {fmtMoney(t.realized_pnl)}
                        </span>
                      )}
                      <span className="muted small"> {fmtTime(t.created_at)}</span>
                      {t.reason && <p className="reason">💡 {t.reason}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
