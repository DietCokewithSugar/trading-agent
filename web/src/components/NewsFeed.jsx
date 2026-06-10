import React, { useState, useMemo } from 'react';
import { api, fmtTime, TIER_LABELS } from '../api.js';

const PAGE_SIZE = 60;

function AnalysisBadge({ analysis, onSymbolClick }) {
  const symbolBtn = (
    <button className="symbol-link-inline" onClick={() => onSymbolClick(analysis.symbol)}>
      {analysis.symbol}
    </button>
  );
  if (analysis.sentiment === 'neutral' || !analysis.tier) {
    return <span className="badge badge-neutral">中性 · {symbolBtn}</span>;
  }
  const bullish = analysis.sentiment === 'bullish';
  return (
    <span className={`badge ${bullish ? 'badge-bull' : 'badge-bear'}`}>
      {bullish ? '利好' : '利空'} {symbolBtn} · {TIER_LABELS[analysis.tier]}
    </span>
  );
}

export default function NewsFeed({ news, onSymbolClick }) {
  const [filter, setFilter] = useState('analyzed');
  const [search, setSearch] = useState('');
  const [extra, setExtra] = useState([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [noMore, setNoMore] = useState(false);

  // SSE 刷新只更新第一页(news prop),手动加载的后续页保存在 extra 中,按 id 去重合并
  const merged = useMemo(() => {
    const seen = new Set();
    return [...news, ...extra].filter((n) => {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    });
  }, [news, extra]);

  const filtered = merged.filter((n) => {
    if (filter === 'analyzed' && !n.news_analyses?.length) return false;
    if (filter === 'bullish' || filter === 'bearish') {
      if (!n.news_analyses?.some((a) => a.sentiment === filter && a.tier)) return false;
    }
    if (search.trim()) {
      const q = search.trim().toUpperCase();
      const inTitle = n.title?.toUpperCase().includes(q);
      const inSymbols =
        n.symbols?.some((s) => s.includes(q)) ||
        n.news_analyses?.some((a) => a.symbol?.includes(q));
      if (!inTitle && !inSymbols) return false;
    }
    return true;
  });

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const next = await api.news(PAGE_SIZE, merged.length);
      if (next.length < PAGE_SIZE) setNoMore(true);
      setExtra((prev) => [...prev, ...next]);
    } catch { /* 下次再试 */ }
    setLoadingMore(false);
  };

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
        <input
          className="search-input"
          placeholder="🔍 搜索标题或股票代码…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
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
                  <button key={s} className="chip-sm" onClick={() => onSymbolClick(s)}>
                    {s}
                  </button>
                ))}
              </div>
              {n.news_analyses?.map((a) => (
                <div key={a.id} className="analysis">
                  <AnalysisBadge analysis={a} onSymbolClick={onSymbolClick} />
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
