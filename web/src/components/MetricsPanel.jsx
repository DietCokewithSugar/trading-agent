import React from 'react';
import { fmtMoney, fmtPercent } from '../api.js';
import SegmentedBar from './SegmentedBar.jsx';

/**
 * 关键指标栏(仪表盘右列):行式指标 + 细分隔线,一屏读完组合体检表。
 * 胜率与回撤附分段条,其余为「主值 + 副行」两级信息。
 */
export default function MetricsPanel({ stats, performance }) {
  const winRate =
    stats?.win_rate !== null && stats?.win_rate !== undefined ? stats.win_rate : null;
  const drawdown = stats?.max_drawdown_percent ?? null;

  const rows = [
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
      label: '夏普比率(年化)',
      value:
        performance?.sharpe_ratio !== null && performance?.sharpe_ratio !== undefined
          ? performance.sharpe_ratio.toFixed(2)
          : '—',
      sub: performance?.trading_days
        ? `基于 ${performance.trading_days} 个交易日净值`
        : '需至少 3 个交易日数据',
      tone: performance?.sharpe_ratio > 1 ? 'up' : '',
    },
    {
      label: '交易胜率',
      value: winRate !== null ? `${winRate.toFixed(0)}%` : '—',
      sub: stats?.sell_count
        ? `${stats.win_count} 胜 / ${stats.sell_count - stats.win_count} 负`
        : '暂无平仓记录',
      tone: '',
      bar: winRate !== null ? { value: winRate, max: 100, tone: 'neutral' } : null,
    },
    {
      label: '最大回撤',
      value:
        stats?.max_drawdown_percent !== undefined
          ? `-${(stats.max_drawdown_percent ?? 0).toFixed(2)}%`
          : '—',
      sub: `累计 ${stats?.total_trades ?? 0} 笔交易`,
      tone: (stats?.max_drawdown_percent ?? 0) > 5 ? 'down' : '',
      bar: drawdown !== null ? { value: drawdown, max: 50, tone: 'down' } : null,
    },
  ];

  return (
    <div>
      {rows.map((r) => (
        <div className="metric-row" key={r.label}>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <span className="label-caps">{r.label}</span>
            {r.bar && (
              <div style={{ marginTop: 6, maxWidth: 180 }}>
                <SegmentedBar value={r.bar.value} max={r.bar.max} tone={r.bar.tone} segments={12} />
              </div>
            )}
          </div>
          <div className={`metric-row__value num ${r.tone}`}>
            {r.value}
            <span className="metric-row__sub num">{r.sub}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
