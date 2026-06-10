import React, { useMemo } from 'react';
import { Card, Col, Row, Statistic, Typography } from 'antd';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from 'recharts';
import { fmtMoney, fmtPercent } from '../api.js';
import { CHART, PIE_COLORS } from '../theme.js';

// 饼图最多展示的切片数,其余持仓合并为「其他」,防止图例溢出卡片
const MAX_SLICES = 8;

export default function StatsCards({ stats, performance, portfolio }) {
  const cards = [
    {
      label: '累计收益率',
      value:
        performance?.cumulative_return_percent !== null &&
        performance?.cumulative_return_percent !== undefined
          ? fmtPercent(performance.cumulative_return_percent)
          : '—',
      sub:
        performance?.benchmark?.excess_return_percent !== null &&
        performance?.benchmark?.excess_return_percent !== undefined
          ? `对比 SPY ${fmtPercent(performance.benchmark.excess_return_percent)}`
          : '暂无 SPY 基准数据',
      tone:
        performance?.cumulative_return_percent > 0
          ? 'up'
          : performance?.cumulative_return_percent < 0
            ? 'down'
            : '',
    },
    {
      label: '夏普比率(年化)',
      value:
        performance?.sharpe_ratio !== null && performance?.sharpe_ratio !== undefined
          ? performance.sharpe_ratio.toFixed(2)
          : '数据不足',
      sub: performance?.trading_days
        ? `基于 ${performance.trading_days} 个交易日净值`
        : '需至少 3 个交易日数据',
      tone: performance?.sharpe_ratio > 1 ? 'up' : '',
    },
    {
      label: '今日盈亏',
      value: stats?.day_pnl !== null && stats?.day_pnl !== undefined ? fmtMoney(stats.day_pnl) : '—',
      sub:
        stats?.day_pnl_percent !== null && stats?.day_pnl_percent !== undefined
          ? fmtPercent(stats.day_pnl_percent)
          : '今日暂无对比基准',
      tone: stats?.day_pnl > 0 ? 'up' : stats?.day_pnl < 0 ? 'down' : '',
    },
    {
      label: '已实现盈亏',
      value: fmtMoney(stats?.realized_pnl ?? 0),
      sub: `共 ${stats?.sell_count ?? 0} 笔卖出`,
      tone: (stats?.realized_pnl ?? 0) > 0 ? 'up' : (stats?.realized_pnl ?? 0) < 0 ? 'down' : '',
    },
    {
      label: '交易胜率',
      value:
        stats?.win_rate !== null && stats?.win_rate !== undefined
          ? `${stats.win_rate.toFixed(0)}%`
          : '—',
      sub: stats?.sell_count
        ? `${stats.win_count} 胜 / ${stats.sell_count - stats.win_count} 负`
        : '暂无平仓记录',
      tone: '',
    },
    {
      label: '最大回撤',
      value:
        stats?.max_drawdown_percent !== undefined
          ? `-${(stats.max_drawdown_percent ?? 0).toFixed(2)}%`
          : '—',
      sub: `累计 ${stats?.total_trades ?? 0} 笔交易`,
      tone: (stats?.max_drawdown_percent ?? 0) > 5 ? 'down' : '',
    },
  ];

  // 资产配置:按市值排序取前 MAX_SLICES 项,其余合并为「其他」,图例不会撑爆卡片
  const pieData = useMemo(() => {
    if (!portfolio) return [];
    const raw = [
      ...(portfolio.positions || []).map((p) => ({
        name: p.symbol,
        value: Math.max(p.market_value, 0),
      })),
      { name: '现金', value: Math.max(portfolio.cash, 0) },
    ]
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);
    if (raw.length <= MAX_SLICES + 1) return raw;
    return [
      ...raw.slice(0, MAX_SLICES),
      {
        name: `其他 (${raw.length - MAX_SLICES})`,
        value: raw.slice(MAX_SLICES).reduce((sum, d) => sum + d.value, 0),
      },
    ];
  }, [portfolio]);

  return (
    <Card title="组合统计" styles={{ body: { overflow: 'hidden' } }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={pieData.length ? 15 : 24}>
          <Row gutter={[12, 20]}>
            {cards.map((c) => (
              <Col xs={12} sm={8} key={c.label}>
                <Statistic
                  title={c.label}
                  valueRender={() => <span className={`num ${c.tone}`}>{c.value}</span>}
                  valueStyle={{ fontSize: 20 }}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {c.sub}
                </Typography.Text>
              </Col>
            ))}
          </Row>
        </Col>
        {pieData.length > 0 && (
          <Col xs={24} lg={9}>
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  cy="44%"
                  innerRadius={42}
                  outerRadius={68}
                  paddingAngle={2}
                  stroke="#fff"
                  strokeWidth={1}
                >
                  {pieData.map((entry, i) => (
                    <Cell key={entry.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: CHART.tooltipBg,
                    border: `1px solid ${CHART.tooltipBorder}`,
                    borderRadius: 8,
                    boxShadow: CHART.tooltipShadow,
                  }}
                  formatter={(value, name) => [fmtMoney(value), name]}
                />
                <Legend
                  layout="horizontal"
                  verticalAlign="bottom"
                  align="center"
                  iconSize={8}
                  wrapperStyle={{ fontSize: 12 }}
                />
              </PieChart>
            </ResponsiveContainer>
            <Typography.Paragraph type="secondary" style={{ textAlign: 'center', fontSize: 12, margin: 0 }}>
              资产配置
            </Typography.Paragraph>
          </Col>
        )}
      </Row>
    </Card>
  );
}
