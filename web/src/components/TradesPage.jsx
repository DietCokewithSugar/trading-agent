import React from 'react';
import { fmtMoney, fmtNum, fmtTime, TIER_LABELS } from '../api.js';

export default function TradesPage({ trades }) {
  if (!trades?.length) {
    return <p className="empty">暂无交易记录。出现高档位的利好/利空新闻时,AI 会自动执行模拟买卖。</p>;
  }

  return (
    <ul className="news-list">
      {trades.map((t) => (
        <li key={t.id} className="card">
          <div className="trade-head">
            <span className={`badge ${t.side === 'buy' ? 'badge-buy' : 'badge-sell'}`}>
              {t.side === 'buy' ? '买入' : '卖出'}
            </span>
            <span className="symbol">{t.symbol}</span>
            <span>
              {fmtNum(t.quantity, 4)} 股 × {fmtMoney(t.price)} = {fmtMoney(t.amount)}
            </span>
            {t.realized_pnl !== null && t.realized_pnl !== undefined && (
              <span className={Number(t.realized_pnl) >= 0 ? 'up' : 'down'}>
                已实现盈亏 {fmtMoney(t.realized_pnl)}
              </span>
            )}
            <span className="muted">{fmtTime(t.created_at)}</span>
          </div>

          {t.reason && <p className="reason">💡 决策原因:{t.reason}</p>}

          {t.news_analyses && (
            <p className="muted small">
              信号:{t.news_analyses.sentiment === 'bullish' ? '利好' : '利空'}
              {t.news_analyses.tier ? ` · ${TIER_LABELS[t.news_analyses.tier]}` : ''}
            </p>
          )}

          {t.news_articles && (
            <p className="small">
              📰 触发新闻:
              <a href={t.news_articles.url} target="_blank" rel="noreferrer">
                {t.news_articles.title}
              </a>
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
