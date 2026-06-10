import React, { useState, useMemo } from 'react';
import { Button, Empty, Input, Space } from 'antd';
import TradeItem from './TradeItem.jsx';
import { api } from '../api.js';

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
    return <Empty description="暂无交易记录。出现高档位的利好/利空新闻时,AI 会自动执行模拟买卖。" />;
  }

  return (
    <div>
      <Input.Search
        allowClear
        placeholder="按股票代码筛选"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ maxWidth: 280, marginBottom: 16 }}
      />

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {filtered.map((t) => (
          <TradeItem key={t.id} trade={t} onSymbolClick={onSymbolClick} />
        ))}
      </Space>

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
