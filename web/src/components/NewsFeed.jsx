import React, { useState, useMemo } from 'react';
import { Button, Card, Empty, Input, Segmented, Space, Tag, Typography } from 'antd';
import { api, fmtTime, TIER_LABELS } from '../api.js';

const PAGE_SIZE = 60;

const FILTERS = [
  { value: 'analyzed', label: '已分析' },
  { value: 'bullish', label: '利好' },
  { value: 'bearish', label: '利空' },
  { value: 'all', label: '全部新闻' },
];

/** 利好绿/利空红(美股惯例) */
function AnalysisBadge({ analysis, onSymbolClick }) {
  const symbolBtn = (
    <Button
      type="link"
      size="small"
      style={{ padding: 0, height: 'auto' }}
      onClick={() => onSymbolClick(analysis.symbol)}
    >
      {analysis.symbol}
    </Button>
  );
  if (analysis.sentiment === 'neutral' || !analysis.tier) {
    return (
      <Space size={4}>
        <Tag style={{ marginRight: 0 }}>中性</Tag>
        {symbolBtn}
      </Space>
    );
  }
  const bullish = analysis.sentiment === 'bullish';
  return (
    <Space size={4} wrap>
      <Tag color={bullish ? 'green' : 'red'} style={{ marginRight: 0 }}>
        {bullish ? '利好' : '利空'}
      </Tag>
      {symbolBtn}
      <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
        {TIER_LABELS[analysis.tier]}
      </Typography.Text>
    </Space>
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
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented options={FILTERS} value={filter} onChange={setFilter} />
        <Input.Search
          allowClear
          placeholder="搜索标题或股票代码"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 240 }}
        />
      </Space>

      {!filtered.length ? (
        <Empty description="暂无符合条件的新闻。系统会按设定间隔自动抓取并分析最新新闻。" />
      ) : (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {filtered.map((n) => (
            <Card size="small" key={n.id}>
              <a href={n.url} target="_blank" rel="noreferrer" style={{ fontWeight: 500 }}>
                {n.title}
              </a>
              <div style={{ marginTop: 6 }}>
                <Space size={8} wrap>
                  <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                    {n.publisher || n.source}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                    {fmtTime(n.published_at)}
                  </Typography.Text>
                  {n.symbols?.map((s) => (
                    <Tag
                      key={s}
                      style={{ marginRight: 0, cursor: 'pointer' }}
                      onClick={() => onSymbolClick(s)}
                    >
                      {s}
                    </Tag>
                  ))}
                </Space>
              </div>
              {n.news_analyses?.map((a) => (
                <div key={a.id} style={{ marginTop: 8 }}>
                  <Space size={8} wrap>
                    <AnalysisBadge analysis={a} onSymbolClick={onSymbolClick} />
                    {typeof a.confidence === 'number' && (
                      <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                        置信度 {(a.confidence * 100).toFixed(0)}%
                      </Typography.Text>
                    )}
                  </Space>
                  {a.reasoning && (
                    <p className="reason">
                      <span className="reason-label">分析理由</span>
                      {a.reasoning}
                    </p>
                  )}
                </div>
              ))}
            </Card>
          ))}
        </Space>
      )}

      {!noMore && merged.length >= PAGE_SIZE && (
        <div className="load-more-row">
          <Button onClick={loadMore} loading={loadingMore}>
            加载更多
          </Button>
        </div>
      )}
    </div>
  );
}
