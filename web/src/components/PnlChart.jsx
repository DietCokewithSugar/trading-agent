import React, { useEffect, useMemo, useState } from 'react';
import { Segmented, Typography } from 'antd';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  CartesianGrid,
} from 'recharts';
import { api, fmtMoney, fmtNum, fmtPercent } from '../api.js';
import { CHART, COLOR_UP, COLOR_DOWN } from '../theme.js';

const RANGES = [
  { key: '1d', label: '1天', hours: 24 },
  { key: '1w', label: '1周', hours: 24 * 7 },
  { key: '1m', label: '1月', hours: 24 * 30 },
  { key: 'all', label: '全部', hours: null },
];

/** 买卖点标记:买入绿色▲,卖出红色▼(美股惯例),悬停显示交易详情(SVG 原生 title) */
function TradeMarker(props) {
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined || !payload?.trade) return null;
  const t = payload.trade;
  const buy = t.side === 'buy';
  const title = `${buy ? '买入' : '卖出'} ${t.symbol} ${fmtNum(t.quantity, 4)} 股 @ ${fmtMoney(t.price)}\n${t.reason || ''}`;
  return (
    <g>
      <title>{title}</title>
      <path
        d={buy ? `M ${cx} ${cy - 6} L ${cx - 5} ${cy + 4} L ${cx + 5} ${cy + 4} Z`
               : `M ${cx} ${cy + 6} L ${cx - 5} ${cy - 4} L ${cx + 5} ${cy - 4} Z`}
        fill={buy ? COLOR_UP : COLOR_DOWN}
        stroke={CHART.markerStroke}
        strokeWidth={1}
      />
    </g>
  );
}

// 参考基线线色按 symbol 取色,未知基准回退灰色
const BENCHMARK_COLORS = { SPY: CHART.benchmark, GLD: CHART.benchmarkGold };

export default function PnlChart({ snapshots, trades, initialCapital, benchmarks }) {
  const [rangeKey, setRangeKey] = useState('all');
  const [rangeData, setRangeData] = useState(null);

  const range = RANGES.find((r) => r.key === rangeKey);

  // 非"全部"范围时单独拉取对应时间段的采样数据;有新快照(snapshots 增长)时跟着刷新
  useEffect(() => {
    if (!range.hours) {
      setRangeData(null);
      return;
    }
    let cancelled = false;
    api
      .snapshots(range.hours)
      .then((rows) => !cancelled && setRangeData(rows))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [rangeKey, snapshots.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = range.hours ? rangeData || [] : snapshots;

  const { data, markers } = useMemo(() => {
    const data = rows.map((s) => ({
      time: new Date(s.created_at).getTime(),
      total: Number(s.total_value),
      pnl: Number(s.pnl),
      pnlPercent: Number(s.pnl_percent),
    }));
    if (!data.length) return { data, markers: [] };

    const minTime = data[0].time;
    const maxTime = data[data.length - 1].time;
    // 把交易映射到时间最近的净值点上,作为标记的 y 坐标
    const markers = (trades || [])
      .map((t) => {
        const time = new Date(t.created_at).getTime();
        if (time < minTime || time > maxTime + 60_000) return null;
        let nearest = data[0];
        for (const d of data) {
          if (Math.abs(d.time - time) < Math.abs(nearest.time - time)) nearest = d;
        }
        return { time, total: nearest.total, trade: t };
      })
      .filter(Boolean);
    return { data, markers };
  }, [rows, trades]);

  // 买入持有参考基线(标普500/黄金,日线):1 天视图下日线粒度太粗,不展示
  const benchmarkSeries = useMemo(() => {
    if (rangeKey === '1d' || !benchmarks?.length || !data.length) return [];
    const minTime = data[0].time - 24 * 3600_000;
    const maxTime = data[data.length - 1].time + 24 * 3600_000;
    return benchmarks
      .filter((b) => b?.series?.length)
      .map((b) => ({
        symbol: b.symbol,
        name: b.name || b.symbol,
        rows: b.series
          .map((p) => ({
            // 日线点定位到当日美股收盘附近(20:00 UTC)
            time: new Date(`${p.date}T20:00:00Z`).getTime(),
            benchmark: p.value,
          }))
          .filter((p) => p.time >= minTime && p.time <= maxTime),
      }))
      .filter((b) => b.rows.length > 1);
  }, [benchmarks, data, rangeKey]);

  // 自适应 Y 轴:窄幅波动时旧的「$xx.xk」格式会让所有刻度显示成同一个值,
  // 这里按实际数值跨度选择精度,并给上下各留 8% 空间
  const { yDomain, fmtTick } = useMemo(() => {
    const values = [
      ...data.map((d) => d.total),
      ...benchmarkSeries.flatMap((b) => b.rows.map((d) => d.benchmark)),
    ].filter((v) => Number.isFinite(v));
    if (!values.length) {
      return { yDomain: ['auto', 'auto'], fmtTick: (v) => `$${(v / 1000).toFixed(1)}k` };
    }
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    // 完全平坦的序列也要有非零跨度,避免 domain 退化
    const span = Math.max(hi - lo, Math.max(Math.abs(hi) * 0.002, 1));
    const pad = span * 0.08;
    const fmtTick =
      span >= 20000
        ? (v) => `$${(v / 1000).toFixed(0)}k`
        : span >= 2000
          ? (v) => `$${(v / 1000).toFixed(1)}k`
          : span >= 100
            ? (v) => `$${Math.round(v).toLocaleString('en-US')}`
            : (v) => `$${Number(v).toFixed(2)}`;
    return { yDomain: [lo - pad, hi + pad], fmtTick };
  }, [data, benchmarkSeries]);

  return (
    <div>
      <div className="header-actions" style={{ marginBottom: 12 }}>
        <Segmented
          size="small"
          options={RANGES.map((r) => ({ label: r.label, value: r.key }))}
          value={rangeKey}
          onChange={setRangeKey}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          ▲ 买入 ▼ 卖出(悬停看详情)
          {benchmarkSeries.length
            ? ` · ┄ ${benchmarkSeries.map((b) => b.name).join(' / ')} 基准`
            : ''}
        </Typography.Text>
      </div>

      {!data.length ? (
        <Typography.Text type="secondary">该时间范围内暂无净值数据。</Typography.Text>
      ) : (
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={data} margin={{ top: 10, right: 8, bottom: 0, left: 4 }}>
            <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" />
            <XAxis
              dataKey="time"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(t) =>
                new Date(t).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              }
              stroke={CHART.axis}
              fontSize={12}
            />
            <YAxis
              domain={yDomain}
              tickCount={6}
              tickFormatter={fmtTick}
              stroke={CHART.axis}
              fontSize={12}
              width={62}
            />
            <Tooltip
              contentStyle={{
                background: CHART.tooltipBg,
                border: `1px solid ${CHART.tooltipBorder}`,
                borderRadius: 8,
                boxShadow: CHART.tooltipShadow,
              }}
              labelFormatter={(t) => new Date(t).toLocaleString('zh-CN')}
              formatter={(value, name, props) => {
                if (name === 'total') {
                  return [
                    `${fmtMoney(value)}(盈亏 ${fmtMoney(props.payload.pnl)} / ${fmtPercent(props.payload.pnlPercent)})`,
                    '总资产',
                  ];
                }
                if (props?.dataKey === 'benchmark') {
                  return [fmtMoney(value), `${name} 基准(同期买入持有)`];
                }
                return null;
              }}
            />
            {initialCapital && (
              <ReferenceLine
                y={Number(initialCapital)}
                stroke={CHART.reference}
                strokeDasharray="4 4"
                ifOverflow="hidden"
                label={{ value: '初始资金', fill: CHART.axis, fontSize: 12, position: 'insideTopRight' }}
              />
            )}
            <Line
              type="monotone"
              dataKey="total"
              stroke={data[data.length - 1].pnl >= 0 ? COLOR_UP : COLOR_DOWN}
              strokeWidth={2}
              dot={false}
            />
            {benchmarkSeries.map((b) => (
              <Line
                key={b.symbol}
                data={b.rows}
                name={b.name}
                type="monotone"
                dataKey="benchmark"
                stroke={BENCHMARK_COLORS[b.symbol] || CHART.benchmark}
                strokeWidth={1.5}
                strokeDasharray="5 4"
                dot={false}
              />
            ))}
            <Scatter data={markers} dataKey="total" shape={<TradeMarker />} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
