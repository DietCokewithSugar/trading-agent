import React, { useMemo } from 'react';
import { Button, Card, Col, Empty, Row, Space, Table, Tag, Tooltip } from 'antd';
import NetWorthChart from './NetWorthChart.jsx';
import MetricsPanel from './MetricsPanel.jsx';
import FlashOnChange from './FlashOnChange.jsx';
import SessionBadge from './SessionBadge.jsx';
import { fmtMoney, fmtNum, fmtPercent, fmtTime, TRIGGER_LABELS } from '../api.js';
import { getPieColors } from '../theme.js';
import { useThemeMode } from '../theme-context.jsx';

// 配置条最多单独展示的持仓段数,其余合并为「其他」
const MAX_ALLOC_SEGMENTS = 8;

/** 资产配置条:持仓按市值降序的水平堆叠条 + 图例(替代饼图,一行读完仓位结构) */
function AllocationStrip({ portfolio }) {
  const { mode } = useThemeMode();
  const colors = getPieColors(mode);

  const segments = useMemo(() => {
    if (!portfolio) return [];
    const total = Number(portfolio.total_value) || 0;
    if (total <= 0) return [];
    const raw = (portfolio.positions || [])
      .map((p) => ({ name: p.symbol, value: Math.max(Number(p.market_value) || 0, 0) }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);
    const head = raw.slice(0, MAX_ALLOC_SEGMENTS);
    const rest = raw.slice(MAX_ALLOC_SEGMENTS);
    if (rest.length) {
      head.push({ name: `其他 (${rest.length})`, value: rest.reduce((s, d) => s + d.value, 0) });
    }
    const cash = Math.max(Number(portfolio.cash) || 0, 0);
    const list = head.map((d, i) => ({ ...d, color: colors[Math.min(i, colors.length - 1)] }));
    if (cash > 0) list.push({ name: '现金', value: cash, color: 'var(--border-visible)' });
    return list.map((d) => ({ ...d, percent: (d.value / total) * 100 }));
  }, [portfolio, colors]);

  if (!segments.length) return null;
  return (
    <div className="alloc">
      <div className="alloc__track">
        {segments.map((s) => (
          <Tooltip key={s.name} title={`${s.name} · ${fmtMoney(s.value)} · ${s.percent.toFixed(1)}%`}>
            <span className="alloc__seg" style={{ width: `${s.percent}%`, background: s.color }} />
          </Tooltip>
        ))}
      </div>
      <div className="alloc__legend">
        {segments.map((s) => (
          <span className="alloc__chip" key={s.name}>
            <span className="alloc__dot" style={{ background: s.color }} />
            {s.name}
            <span className="num muted">{s.percent.toFixed(1)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** 止损→止盈风控区间微条:现价圆点落在区间上,一眼读出离触发线的距离 */
function RiskBand({ stopLoss, takeProfit, price }) {
  const lo = Number(stopLoss);
  const hi = Number(takeProfit);
  if (!Number.isFinite(lo) && !Number.isFinite(hi)) return <span className="muted">—</span>;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    // 只有单边线(如移动止损策略不设止盈)时退回文本
    return (
      <span className="muted num small">
        {Number.isFinite(lo) ? `止损 ${fmtMoney(lo)}` : `止盈 ${fmtMoney(hi)}`}
      </span>
    );
  }
  const ratio = Math.min(Math.max(((Number(price) || lo) - lo) / (hi - lo), 0), 1);
  return (
    <Tooltip title={`止损 ${fmtMoney(lo)} · 现价 ${fmtMoney(price)} · 止盈 ${fmtMoney(hi)}`}>
      <div className="slband">
        <div className="slband__track">
          <span className="slband__dot" style={{ left: `${ratio * 100}%` }} />
        </div>
        <div className="slband__labels">
          <span>{fmtMoney(lo)}</span>
          <span>{fmtMoney(hi)}</span>
        </div>
      </div>
    </Tooltip>
  );
}

export default function Dashboard({ portfolio, snapshots, trades, stats, performance, onSymbolClick, onNavigate }) {
  const totalValue = Number(portfolio?.total_value) || 0;

  const positionColumns = [
    {
      title: '代码',
      dataIndex: 'symbol',
      fixed: 'left',
      width: 96,
      render: (symbol, p) => (
        <div>
          <Button type="link" size="small" style={{ padding: 0, fontWeight: 600 }} onClick={() => onSymbolClick(symbol)}>
            {symbol}
          </Button>
          {/* 停牌标记(028):停牌期间止损/止盈暂停、现价为停牌前最后成交价 */}
          {p.halted && (
            <Tag color="orange" style={{ marginLeft: 4, marginRight: 0, fontSize: 11, lineHeight: '16px', padding: '0 4px' }}>
              停牌
            </Tag>
          )}
          {totalValue > 0 && (
            <span className="cell-sub num">{(((Number(p.market_value) || 0) / totalValue) * 100).toFixed(1)}% 仓位</span>
          )}
        </div>
      ),
    },
    {
      title: '现价',
      dataIndex: 'current_price',
      align: 'right',
      width: 130,
      render: (v, p) => (
        <div>
          <Space size={4}>
            <SessionBadge
              session={p.session}
              extendedPrice={p.extended_price}
              extendedChangePercent={p.extended_change_percent}
            />
            <FlashOnChange value={v} className="num">{fmtMoney(v)}</FlashOnChange>
          </Space>
          {/* 报价缺失(null)不着色:null >= 0 为 true,会把占位符误染涨色 */}
          <span
            className={`cell-sub num ${
              p.change_percent === null || p.change_percent === undefined
                ? ''
                : p.change_percent >= 0
                  ? 'up'
                  : 'down'
            }`}
          >
            今日 {fmtPercent(p.change_percent)}
          </span>
        </div>
      ),
    },
    {
      title: '持仓 / 成本',
      dataIndex: 'quantity',
      align: 'right',
      width: 120,
      render: (v, p) => (
        <div>
          <span className="num">{fmtNum(v, 4)} 股</span>
          <span className="cell-sub num">@ {fmtMoney(p.avg_cost)}</span>
        </div>
      ),
    },
    {
      title: '市值',
      dataIndex: 'market_value',
      align: 'right',
      width: 110,
      render: (v) => <span className="num">{fmtMoney(v)}</span>,
    },
    {
      title: '浮动盈亏',
      dataIndex: 'unrealized_pnl',
      align: 'right',
      width: 130,
      render: (v, p) => (
        <div>
          <span className={`num ${v >= 0 ? 'up' : 'down'}`}>{fmtMoney(v)}</span>
          <span className={`cell-sub num ${v >= 0 ? 'up' : 'down'}`}>
            {fmtPercent(p.unrealized_pnl_percent)}
          </span>
        </div>
      ),
    },
    {
      title: '风控区间',
      dataIndex: 'stop_loss',
      width: 140,
      render: (v, p) => <RiskBand stopLoss={p.stop_loss} takeProfit={p.take_profit} price={p.current_price} />,
    },
  ];

  const recentColumns = [
    {
      title: '时间',
      dataIndex: 'created_at',
      width: 96,
      render: (v) => <span className="num muted">{fmtTime(v)}</span>,
    },
    {
      title: '方向',
      dataIndex: 'side',
      width: 110,
      render: (side, t) => (
        <Space size={4}>
          <Tag color={side === 'buy' ? 'green' : 'red'} style={{ marginRight: 0 }}>
            {side === 'buy' ? '买入' : '卖出'}
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
      width: 170,
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
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Card title="账户净值走势" styles={{ body: { paddingTop: 16 } }}>
            <NetWorthChart
              snapshots={snapshots}
              trades={trades}
              initialCapital={portfolio?.initial_capital}
              benchmarks={
                performance?.benchmarks ?? (performance?.benchmark ? [performance.benchmark] : [])
              }
            />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="关键指标" style={{ height: '100%' }}>
            <MetricsPanel stats={stats} performance={performance} />
          </Card>
        </Col>
      </Row>

      <Card title={`当前持仓${portfolio?.positions?.length ? ` (${portfolio.positions.length})` : ''}`}>
        {!portfolio?.positions?.length ? (
          <Empty description="暂无持仓。AI 会在出现高档位利好新闻时自动建仓。" />
        ) : (
          <>
            <AllocationStrip portfolio={portfolio} />
            <Table
              size="small"
              rowKey="symbol"
              pagination={false}
              scroll={{ x: 760 }}
              columns={positionColumns}
              dataSource={portfolio.positions}
            />
          </>
        )}
      </Card>

      <Card
        title="最近交易"
        extra={
          trades?.length ? (
            <Button type="link" size="small" onClick={() => onNavigate?.('trades')}>
              查看全部
            </Button>
          ) : null
        }
      >
        {!trades?.length ? (
          <Empty description="暂无交易记录。" />
        ) : (
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            scroll={{ x: 700 }}
            columns={recentColumns}
            dataSource={trades.slice(0, 8)}
          />
        )}
      </Card>
    </Space>
  );
}
