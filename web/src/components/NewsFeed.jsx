import React, { useEffect, useRef, useState } from 'react';
import { Button, Card, Empty, Input, Segmented, Space, Spin, Tag, Typography } from 'antd';
import { api, fmtTime, TIER_LABELS } from '../api.js';

const PAGE_SIZE = 60;
// SSE 自动刷新合并时本地最多保留的条数,防止长期挂机内存无限增长
const MAX_ITEMS = 600;
const SEARCH_DEBOUNCE_MS = 400;

const FILTERS = [
  { value: 'analyzed', label: '已分析' },
  { value: 'bullish', label: '利好' },
  { value: 'bearish', label: '利空' },
  { value: 'all', label: '全部新闻' },
];

/** 来源可信度配色:高=绿,中=默认,低=橙(与涨跌色无关,仅表示信源质量) */
function credibilityColor(score) {
  if (score >= 0.8) return 'green';
  if (score >= 0.6) return 'default';
  return 'orange';
}

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

/**
 * 新闻页:筛选/搜索/分页全部由服务端完成,本地只保留当前展示的数据。
 * version 变化(SSE 收到新新闻/新分析)时重拉第一页并与已加载内容去重合并。
 */
export default function NewsFeed({ version, onSymbolClick }) {
  const [filter, setFilter] = useState('analyzed');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [noMore, setNoMore] = useState(false);
  const queryKeyRef = useRef(null);

  // 搜索防抖,避免每敲一个字符都打一次接口
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const key = `${filter}|${query}`;
    const isNewQuery = key !== queryKeyRef.current;
    let cancelled = false;
    if (isNewQuery) setLoading(true);

    api
      .news({ limit: PAGE_SIZE, filter, q: query })
      .then((rows) => {
        if (cancelled) return;
        queryKeyRef.current = key;
        if (isNewQuery) {
          setItems(rows);
          setNoMore(rows.length < PAGE_SIZE);
        } else {
          // SSE 触发的刷新:新第一页与已加载的后续页去重合并,并限制总量
          setItems((prev) => {
            const seen = new Set(rows.map((r) => r.id));
            return [...rows, ...prev.filter((p) => !seen.has(p.id))].slice(0, MAX_ITEMS);
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter, query, version]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const next = await api.news({ limit: PAGE_SIZE, offset: items.length, filter, q: query });
      if (next.length < PAGE_SIZE) setNoMore(true);
      setItems((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...next.filter((n) => !seen.has(n.id))];
      });
    } catch {
      /* 下次再试 */
    }
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

      {loading && !items.length ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : !items.length ? (
        <Empty description="暂无符合条件的新闻。系统会按设定间隔自动抓取并分析最新新闻。" />
      ) : (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {items.map((n) => (
            <Card size="small" key={n.id}>
              <a href={n.url} target="_blank" rel="noreferrer" style={{ fontWeight: 500 }}>
                {n.title}
              </a>
              <div style={{ marginTop: 6 }}>
                <Space size={8} wrap>
                  <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                    {n.publisher || n.source}
                  </Typography.Text>
                  {typeof n.source_score === 'number' || typeof n.source_score === 'string' ? (
                    <Tag
                      color={credibilityColor(Number(n.source_score))}
                      style={{ marginRight: 0, fontSize: 12 }}
                    >
                      来源可信度 {(Number(n.source_score) * 100).toFixed(0)}%
                    </Tag>
                  ) : null}
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
                    {a.final_confidence !== null && a.final_confidence !== undefined && (
                      <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                        综合置信度 {(Number(a.final_confidence) * 100).toFixed(0)}%
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

      {!noMore && items.length >= PAGE_SIZE && (
        <div className="load-more-row">
          <Button onClick={loadMore} loading={loadingMore}>
            加载更多
          </Button>
        </div>
      )}
    </div>
  );
}
