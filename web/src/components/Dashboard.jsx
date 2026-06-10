import React from 'react';
import { Button, Card, Descriptions, Empty, Space, Table, Tag } from 'antd';
import PnlChart from './PnlChart.jsx';
import StatsCards from './StatsCards.jsx';
import TradeItem from './TradeItem.jsx';
import { fmtMoney, fmtNum, fmtPercent, fmtTime, SESSION_LABELS } from '../api.js';

export default function Dashboard({ portfolio, snapshots, trades, stats, performance, status, onSymbolClick }) {
  const positionColumns = [
    {
      title: '代码',
      dataIndex: 'symbol',
      fixed: 'left',
      width: 90,
      render: (symbol) => (
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => onSymbolClick(symbol)}>
          {symbol}
        </Button>
      ),
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      width: 100,
      render: (v) => <span className="num">{fmtNum(v, 4)}</span>,
    },
    {
      title: '平均成本',
      dataIndex: 'avg_cost',
      width: 110,
      render: (v) => <span className="num">{fmtMoney(v)}</span>,
    },
    {
      title: '现价',
      dataIndex: 'current_price',
      width: 150,
      render: (v, p) => (
        <Space size={4}>
          <span className="num">{fmtMoney(v)}</span>
          {p.session && p.session !== 'regular' && p.extended_price !== null && (
            <Tag color="orange" style={{ marginRight: 0 }}>
              {SESSION_LABELS[p.session]}
              {p.extended_change_percent !== null && ` ${fmtPercent(p.extended_change_percent)}`}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: '今日涨跌',
      dataIndex: 'change_percent',
      width: 100,
      render: (v) => <span className={`num ${v >= 0 ? 'up' : 'down'}`}>{fmtPercent(v)}</span>,
    },
    {
      title: '止损 / 止盈',
      dataIndex: 'stop_loss',
      width: 150,
      render: (v, p) => (
        <span className="muted num">
          {p.stop_loss ? fmtMoney(p.stop_loss) : '—'} / {p.take_profit ? fmtMoney(p.take_profit) : '—'}
        </span>
      ),
    },
    {
      title: '市值',
      dataIndex: 'market_value',
      width: 120,
      render: (v) => <span className="num">{fmtMoney(v)}</span>,
    },
    {
      title: '浮动盈亏',
      dataIndex: 'unrealized_pnl',
      width: 170,
      render: (v, p) => (
        <span className={`num ${v >= 0 ? 'up' : 'down'}`}>
          {fmtMoney(v)} ({fmtPercent(p.unrealized_pnl_percent)})
        </span>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <StatsCards stats={stats} performance={performance} portfolio={portfolio} />

      <Card title="账户净值走势">
        <PnlChart
          snapshots={snapshots}
          trades={trades}
          initialCapital={portfolio?.initial_capital}
          benchmark={performance?.benchmark}
        />
      </Card>

      <Card title={`当前持仓${portfolio?.positions?.length ? ` (${portfolio.positions.length})` : ''}`}>
        {!portfolio?.positions?.length ? (
          <Empty description="暂无持仓。AI 会在出现高档位利好新闻时自动建仓。" />
        ) : (
          <Table
            size="small"
            rowKey="symbol"
            pagination={false}
            scroll={{ x: 920 }}
            columns={positionColumns}
            dataSource={portfolio.positions}
          />
        )}
      </Card>

      <Card title="最近交易">
        {!trades?.length ? (
          <Empty description="暂无交易记录。" />
        ) : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {trades.slice(0, 5).map((t) => (
              <TradeItem key={t.id} trade={t} onSymbolClick={onSymbolClick} compact />
            ))}
          </Space>
        )}
      </Card>

      {status && (
        <Card title="系统状态">
          <Descriptions size="small" column={{ xs: 1, md: 2 }}>
            <Descriptions.Item label="运行节奏">
              新闻每 {status.pollSeconds} 秒 · 报价推送每 {status.quotePushSeconds} 秒 · 净值快照每{' '}
              {status.snapshotSeconds} 秒 · 止损监控每 {status.riskCheckSeconds} 秒
            </Descriptions.Item>
            <Descriptions.Item label="上次运行">{fmtTime(status.lastRunAt)}</Descriptions.Item>
            {status.lastResult && (
              <Descriptions.Item label="上轮结果">
                新增新闻 {status.lastResult.newArticles} · 分析 {status.lastResult.analyzed} · 信号{' '}
                {status.lastResult.signals} · 成交 {status.lastResult.trades}
              </Descriptions.Item>
            )}
            {status.lastError && (
              <Descriptions.Item label="错误">
                <span className="down">{status.lastError}</span>
              </Descriptions.Item>
            )}
          </Descriptions>
        </Card>
      )}
    </Space>
  );
}
