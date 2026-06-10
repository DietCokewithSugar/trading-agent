import React, { useState } from 'react';
import { fmtTime, TIER_LABELS } from '../api.js';

function AnalysisBadge({ analysis }) {
  if (analysis.sentiment === 'neutral' || !analysis.tier) {
    return <span className="badge badge-neutral">中性 · {analysis.symbol}</span>;
  }
  const bullish = analysis.sentiment === 'bullish';
  return (
    <span className={`badge ${bullish ? 'badge-bull' : 'badge-bear'}`}>
      {bullish ? '利好' : '利空'} {analysis.symbol} · {TIER_LABELS[analysis.tier]}
    </span>
  );
}

export default function NewsFeed({ news }) {
  const [filter, setFilter] = useState('analyzed');

  const filtered = news.filter((n) => {
    if (filter === 'all') return true;
    if (filter === 'analyzed') return n.news_analyses?.length > 0;
    return n.news_analyses?.some(
      (a) => a.sentiment === filter && a.tier
    );
  });

  return (
    <div>
      <div className="filter-row">
        {[
          ['analyzed', '已分析'],
          ['bullish', '利好'],
          ['bearish', '利空'],
          ['all', '全部新闻'],
        ].map(([key, label]) => (
          <button
            key={key}
            className={`chip ${filter === key ? 'active' : ''}`}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {!filtered.length ? (
        <p className="empty">暂无符合条件的新闻。系统会按设定间隔自动抓取并分析最新新闻。</p>
      ) : (
        <ul className="news-list">
          {filtered.map((n) => (
            <li key={n.id} className="card news-item">
              <div className="news-head">
                <a href={n.url} target="_blank" rel="noreferrer" className="news-title">
                  {n.title}
                </a>
              </div>
              <div className="news-meta">
                <span className="muted">{n.publisher || n.source}</span>
                <span className="muted">{fmtTime(n.published_at)}</span>
                {n.symbols?.map((s) => (
                  <span key={s} className="chip-sm">{s}</span>
                ))}
              </div>
              {n.news_analyses?.map((a) => (
                <div key={a.id} className="analysis">
                  <AnalysisBadge analysis={a} />
                  {typeof a.confidence === 'number' && (
                    <span className="muted"> 置信度 {(a.confidence * 100).toFixed(0)}%</span>
                  )}
                  {a.reasoning && <p className="reason">🧠 {a.reasoning}</p>}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
