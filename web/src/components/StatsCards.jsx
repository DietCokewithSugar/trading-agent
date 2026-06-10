import React from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from 'recharts';
import { fmtMoney, fmtPercent } from '../api.js';

const PIE_COLORS = ['#6f8ce8', '#e0524e', '#2fa572', '#c9924d', '#9b7fd4', '#4fb3c9', '#c76fa8', '#7a8294'];

export default function StatsCards({ stats, portfolio }) {
  const cards = [
    {
      label: '今日盈亏',
      value: stats?.day_pnl !== null && stats?.day_pnl !== undefined ? fmtMoney(stats.day_pnl) : '—',
      sub: stats?.day_pnl_percent !== null && stats?.day_pnl_percent !== undefined
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
      value: stats?.win_rate !== null && stats?.win_rate !== undefined
        ? `${stats.win_rate.toFixed(0)}%`
        : '—',
      sub: stats?.sell_count
        ? `${stats.win_count} 胜 / ${stats.sell_count - stats.win_count} 负`
        : '暂无平仓记录',
      tone: '',
    },
    {
      label: '最大回撤',
      value: stats?.max_drawdown_percent !== undefined
        ? `-${(stats.max_drawdown_percent ?? 0).toFixed(2)}%`
        : '—',
      sub: `累计 ${stats?.total_trades ?? 0} 笔交易`,
      tone: (stats?.max_drawdown_percent ?? 0) > 5 ? 'down' : '',
    },
  ];

  const pieData = portfolio
    ? [
        ...(portfolio.positions || []).map((p) => ({
          name: p.symbol,
          value: Math.max(p.market_value, 0),
        })),
        { name: '现金', value: Math.max(portfolio.cash, 0) },
      ].filter((d) => d.value > 0)
    : [];

  return (
    <section className="card">
      <h2>组合统计</h2>
      <div className="stats-row">
        <div className="stats-cards">
          {cards.map((c) => (
            <div key={c.label} className="mini-stat">
              <span className="stat-label">{c.label}</span>
              <span className={`mini-stat-value ${c.tone}`}>{c.value}</span>
              <span className="muted mini-stat-sub">{c.sub}</span>
            </div>
          ))}
        </div>
        {pieData.length > 0 && (
          <div className="pie-wrap">
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={45}
                  outerRadius={70}
                  paddingAngle={2}
                  stroke="none"
                >
                  {pieData.map((entry, i) => (
                    <Cell key={entry.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: '#12151c', border: '1px solid #1f2530', borderRadius: 8 }}
                  formatter={(value, name) => [fmtMoney(value), name]}
                />
                <Legend
                  layout="vertical"
                  align="right"
                  verticalAlign="middle"
                  iconSize={8}
                  formatter={(value) => <span style={{ color: '#7a8294', fontSize: 12 }}>{value}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
            <p className="muted small pie-title">资产配置</p>
          </div>
        )}
      </div>
    </section>
  );
}
