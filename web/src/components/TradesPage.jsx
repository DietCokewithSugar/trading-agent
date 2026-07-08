import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Button, Card, DatePicker, Empty, Input, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import CandidatePool from './CandidatePool.jsx';
import {
  api,
  fmtMoney,
  fmtNum,
  fmtTime,
  TIER_LABELS,
  TRIGGER_LABELS,
  REGIME_LABELS,
  REGIME_TAG_COLORS,
} from '../api.js';

const PAGE_SIZE = 100;

const SIDE_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'buy', label: '买入' },
  { value: 'sell', label: '卖出' },
];

const TRIGGER_FILTERS = [
  { value: 'all', label: '全部触发方式' },
  { value: 'news', label: '新闻信号' },
  { value: 'stop_loss', label: '自动止损' },
  { value: 'take_profit', label: '自动止盈' },
  { value: 'max_hold', label: '持有超时' },
  { value: 'review', label: '持仓复查' },
  { value: 'rotation', label: '止盈腾位' },
];

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

/** 行展开:决策依据 / 信号档位 / 触发新闻(把长文本移出主表,保持行密度) */
function TradeExpand({ trade: t }) {
  return (
    <div style={{ padding: '2px 8px' }}>
      {t.reason && (
        <p className="reason" style={{ margin: 0 }}>
          <span className="reason-label">决策依据</span>
          {t.reason}
        </p>
      )}
      {t.news_analyses && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12.5, margin: '6px 0 0' }}>
          信号:{t.news_analyses.sentiment === 'bullish' ? '利好' : '利空'}
          {t.news_analyses.tier ? ` · ${TIER_LABELS[t.news_analyses.tier]}` : ''}
        </Typography.Paragraph>
      )}
      {t.news_articles && (
        <Typography.Paragraph style={{ fontSize: 12.5, margin: '6px 0 0' }}>
          <Typography.Text type="secondary">触发新闻 </Typography.Text>
          <a href={t.news_articles.url} target="_blank" rel="noreferrer">
            {t.news_articles.title}
          </a>
        </Typography.Paragraph>
      )}
    </div>
  );
}

export default function TradesPage({ trades, macroVersion = 0, onSymbolClick }) {
  const [search, setSearch] = useState('');
  const [side, setSide] = useState('all');
  const [trigger, setTrigger] = useState('all');
  // 选中日期:null = 自动(今天有成交看今天,否则回落到最近有成交的一天)
  const [selectedDate, setSelectedDate] = useState(null);
  const [extra, setExtra] = useState([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [noMore, setNoMore] = useState(false);
  const [pending, setPending] = useState([]);
  // 已按日期补拉过的日子,避免重复请求
  const fetchedDatesRef = useRef(new Set());

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

  // 代码搜索是跨日期的全量检索;未搜索时按天查看
  const searching = Boolean(search.trim());
  // 数据按时间倒序,第一条的日期即「今天或最近有成交的一天」
  const latestActiveDay = merged.length ? dayjs(merged[0].created_at) : null;
  const activeDate = selectedDate || latestActiveDay;

  // 选中早于已加载范围的日期时,以该日结束时间为游标向服务端补拉一页
  useEffect(() => {
    if (!selectedDate || !merged.length) return;
    const key = selectedDate.format('YYYY-MM-DD');
    if (fetchedDatesRef.current.has(key)) return;
    const oldestLoaded = merged[merged.length - 1]?.created_at;
    if (oldestLoaded && selectedDate.endOf('day').isBefore(dayjs(oldestLoaded))) {
      fetchedDatesRef.current.add(key);
      api
        .trades(PAGE_SIZE, { before: selectedDate.endOf('day').toISOString() })
        .then((rows) => setExtra((prev) => [...prev, ...rows]))
        .catch(() => {});
    }
  }, [selectedDate, merged]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    return merged.filter((t) => {
      if (q) {
        if (!t.symbol.includes(q)) return false;
      } else if (activeDate && !dayjs(t.created_at).isSame(activeDate, 'day')) {
        return false;
      }
      if (side !== 'all' && t.side !== side) return false;
      if (trigger !== 'all') {
        // 历史数据的新闻单 trigger 可能为空:按「非其他触发方式」归入新闻信号
        const trig = t.trigger || 'news';
        if (trig !== trigger) return false;
      }
      return true;
    });
  }, [merged, search, side, trigger, activeDate, searching]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      // 游标分页:以已加载最旧一条的时间为界,SSE 推送的新成交不会让翻页漏行
      const oldest = merged[merged.length - 1]?.created_at;
      const next = await api.trades(PAGE_SIZE, oldest ? { before: oldest } : { offset: merged.length });
      if (next.length < PAGE_SIZE) setNoMore(true);
      setExtra((prev) => [...prev, ...next]);
    } catch { /* 下次再试 */ }
    setLoadingMore(false);
  };

  const stepDay = (delta) => {
    if (!activeDate) return;
    const next = activeDate.add(delta, 'day');
    if (next.isAfter(dayjs(), 'day')) return;
    setSelectedDate(next);
  };

  const columns = [
    {
      title: '时间',
      dataIndex: 'created_at',
      width: 100,
      render: (v) => <span className="num muted">{fmtTime(v)}</span>,
    },
    {
      title: '方向',
      dataIndex: 'side',
      width: 130,
      render: (v, t) => (
        <Space size={4}>
          <Tag color={v === 'buy' ? 'green' : 'red'} style={{ marginRight: 0 }}>
            {v === 'buy' ? '买入' : '卖出'}
          </Tag>
          {TRIGGER_LABELS[t.trigger] && (
            <span className="muted small">{TRIGGER_LABELS[t.trigger]}</span>
          )}
        </Space>
      ),
    },
    {
      title: '代码',
      dataIndex: 'symbol',
      width: 90,
      render: (s) => (
        <Button type="link" size="small" style={{ padding: 0, fontWeight: 600 }} onClick={() => onSymbolClick(s)}>
          {s}
        </Button>
      ),
    },
    {
      title: '成交',
      dataIndex: 'quantity',
      align: 'right',
      width: 180,
      render: (v, t) => (
        <span className="num">
          {fmtNum(v, 4)} 股 × {fmtMoney(t.price)}
        </span>
      ),
    },
    {
      title: '金额',
      dataIndex: 'amount',
      align: 'right',
      width: 110,
      render: (v) => <span className="num">{fmtMoney(v)}</span>,
    },
    {
      title: '已实现盈亏',
      dataIndex: 'realized_pnl',
      align: 'right',
      width: 120,
      render: (v) =>
        v === null || v === undefined ? (
          <span className="muted num">—</span>
        ) : (
          <span className={`num ${Number(v) >= 0 ? 'up' : 'down'}`}>{fmtMoney(v)}</span>
        ),
    },
    {
      title: '宏观环境',
      dataIndex: 'macro_regime',
      width: 100,
      responsive: ['md'],
      render: (v) =>
        v && REGIME_LABELS[v] ? (
          <Tag color={REGIME_TAG_COLORS[v]} style={{ marginRight: 0 }}>
            {REGIME_LABELS[v]}
          </Tag>
        ) : (
          <span className="muted">—</span>
        ),
    },
  ];

  return (
    <div>
      <CandidatePool version={macroVersion} onSymbolClick={onSymbolClick} />
      <PendingOrders orders={pending} onSymbolClick={onSymbolClick} />

      {!merged.length ? (
        <Empty description="暂无交易记录。出现高档位的利好/利空新闻时,AI 会自动执行模拟买卖。" />
      ) : (
        <Card
          title={
            searching
              ? `“${search.trim().toUpperCase()}” 的成交 (${filtered.length})`
              : `${activeDate ? activeDate.format('M月D日') : ''} 成交 (${filtered.length})`
          }
          extra={
            <Space wrap>
              {!searching && (
                <Space.Compact size="small">
                  <Button icon={<LeftOutlined />} onClick={() => stepDay(-1)} title="前一天" />
                  <DatePicker
                    size="small"
                    value={activeDate}
                    onChange={setSelectedDate}
                    allowClear={Boolean(selectedDate)}
                    disabledDate={(d) => d.isAfter(dayjs(), 'day')}
                    style={{ width: 130 }}
                  />
                  <Button
                    icon={<RightOutlined />}
                    onClick={() => stepDay(1)}
                    disabled={!activeDate || activeDate.isSame(dayjs(), 'day')}
                    title="后一天"
                  />
                </Space.Compact>
              )}
              <Segmented size="small" options={SIDE_FILTERS} value={side} onChange={setSide} />
              <Select
                size="small"
                style={{ width: 140 }}
                options={TRIGGER_FILTERS}
                value={trigger}
                onChange={setTrigger}
              />
              <Input.Search
                allowClear
                size="small"
                placeholder="按公司代码检索全部"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ width: 170 }}
              />
            </Space>
          }
        >
          {!searching && !selectedDate && latestActiveDay && !latestActiveDay.isSame(dayjs(), 'day') && (
            <Typography.Paragraph type="secondary" style={{ fontSize: 12.5, marginTop: 0, marginBottom: 12 }}>
              今日暂无成交,已显示最近有成交的一天;用日期选择器可查看任意一天。
            </Typography.Paragraph>
          )}
          {!filtered.length ? (
            <Empty description={searching ? '没有匹配该代码的成交记录。' : '该日无成交记录。'} />
          ) : (
            <Table
              rowKey="id"
              size="small"
              columns={columns}
              dataSource={filtered}
              pagination={false}
              scroll={{ x: 840 }}
              expandable={{
                expandedRowRender: (t) => <TradeExpand trade={t} />,
                rowExpandable: (t) => Boolean(t.reason || t.news_analyses || t.news_articles),
              }}
            />
          )}
          {searching && !noMore && merged.length >= PAGE_SIZE && (
            <div className="load-more-row" style={{ marginBottom: 0 }}>
              <Button onClick={loadMore} loading={loadingMore}>
                向更早加载
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
