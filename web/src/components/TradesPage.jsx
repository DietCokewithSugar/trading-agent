import React, { useState, useMemo, useEffect } from 'react';
import { Button, Card, Empty, Input, Space, Table, Tag } from 'antd';
import TradeItem from './TradeItem.jsx';
import { api, fmtMoney, fmtTime } from '../api.js';

const PAGE_SIZE = 100;

/** 等待开盘成交的挂单(休市时段产生的信号),有挂单时显示在交易列表上方 */
function PendingOrders({ orders, onSymbolClick }) {
  if (!orders.length) return null;
  const columns = [
    {
      title: '方向',
      dataIndex: 'side',
      width: 70,
      render: (side) =>
        side === 'buy' ? <Tag color="green">买入</Tag> : <Tag color="red">卖出</Tag>,
    },
    {
      title: '股票',
      dataIndex: 'symbol',
      width: 90,
      render: (s) => (
        <a className="num" onClick={() => onSymbolClick?.(s)}>
          {s}
        </a>
      ),
    },
    {
      title: '决策参考价',
      dataIndex: 'ref_price',
      width: 110,
      align: 'right',
      render: (v) => <span className="num">{fmtMoney(v)}</span>,
    },
    { title: '理由', dataIndex: 'reason', ellipsis: true },
    {
      title: '挂单时间',
      dataIndex: 'created_at',
      width: 110,
      render: (v) => <span className="num">{fmtTime(v)}</span>,
    },
  ];
  return (
    <Card title="待开盘订单" size="small" style={{ marginBottom: 16 }}>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={orders}
        pagination={false}
        scroll={{ x: 560 }}
      />
    </Card>
  );
}

export default function TradesPage({ trades, onSymbolClick }) {
  const [search, setSearch] = useState('');
  const [extra, setExtra] = useState([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [noMore, setNoMore] = useState(false);
  const [pending, setPending] = useState([]);

  // 挂单状态随成交事件变化:trades 更新(SSE trade 事件触发重拉)时一并刷新
  useEffect(() => {
    api.pendingOrders().then(setPending).catch(() => {});
  }, [trades]);

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
    return (
      <div>
        <PendingOrders orders={pending} onSymbolClick={onSymbolClick} />
        <Empty description="暂无交易记录。出现高档位的利好/利空新闻时,AI 会自动执行模拟买卖。" />
      </div>
    );
  }

  return (
    <div>
      <PendingOrders orders={pending} onSymbolClick={onSymbolClick} />
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
