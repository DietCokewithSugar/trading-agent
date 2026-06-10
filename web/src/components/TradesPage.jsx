import React, { useState, useMemo } from 'react';
import { api, fmtMoney, fmtNum, fmtTime, TIER_LABELS, TRIGGER_LABELS } from '../api.js';

const PAGE_SIZE = 100;

export default function TradesPage({ trades, onSymbolClick }) {
  const [search, setSearch] = useState('');
  const [extra, setExtra] = useState([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [noMore, setNoMore] = useState(false);

  const merged = useMemo(() => {
    const seen = new Set();
    return [...trades, ...extra].filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  }, [trades, extra]);

  const filtered = search.trim()
    ? merged.filter((t) => t.symbol.includes(search.trim().toUpperCase()))
    : merged;

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const next = await api.trades(PAGE_SIZE, merged.length);
      if (next.length < PAGE_SIZE) setNoMore(true);
      setExtra((prev) => [...prev, ...next]);
    } catch { /* 下次再试 */ }
    setLoadingMore(false);
  };

  if (!merged.length) {
    return <p className="empty">暂无交易记录。出现高档位的利好/利空新闻时,AI 会自动执行模拟买卖。</p>;
  }

  return (
    <div>
      <div className="filter-row">
        <input
          className="search-input"
          placeholder="按股票代码筛选"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <ul className="news-list">
        {filtered.map((t) => (
          <li key={t.id} className="card">
            <div className="trade-head">
              <span className={`badge ${t.side === 'buy' ? 'badge-buy' : 'badge-sell'}`}>
                {t.side === 'buy' ? '买入' : '卖出'}
              </span>
              {TRIGGER_LABELS[t.trigger] && (
                <span className="badge badge-trigger">{TRIGGER_LABELS[t.trigger]}</span>
              )}
              <button className="symbol symbol-link" onClick={() => onSymbolClick(t.symbol)}>
                {t.symbol}
              </button>
              <span className="num">
                {fmtNum(t.quantity, 4)} 股 × {fmtMoney(t.price)} = {fmtMoney(t.amount)}
              </span>
              {t.realized_pnl !== null && t.realized_pnl !== undefined && (
                <span className={Number(t.realized_pnl) >= 0 ? 'up' : 'down'}>
                  已实现盈亏 {fmtMoney(t.realized_pnl)}
                </span>
              )}
              <span className="muted">{fmtTime(t.created_at)}</span>
            </div>

            {t.reason && (
              <p className="reason">
                <span className="reason-label">决策依据</span>
                {t.reason}
              </p>
            )}

            {t.news_analyses && (
              <p className="muted small">
                信号:{t.news_analyses.sentiment === 'bullish' ? '利好' : '利空'}
                {t.news_analyses.tier ? ` · ${TIER_LABELS[t.news_analyses.tier]}` : ''}
              </p>
            )}

            {t.news_articles && (
              <p className="small">
                <span className="muted">触发新闻 </span>
                <a href={t.news_articles.url} target="_blank" rel="noreferrer">
                  {t.news_articles.title}
                </a>
              </p>
            )}
          </li>
        ))}
      </ul>

      {!noMore && merged.length >= PAGE_SIZE && (
        <div className="load-more-row">
          <button className="btn btn-secondary" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
    </div>
  );
}
