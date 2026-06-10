import React, { useEffect, useMemo, useState } from 'react';
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

const RANGES = [
  { key: '1d', label: '1天', hours: 24 },
  { key: '1w', label: '1周', hours: 24 * 7 },
  { key: '1m', label: '1月', hours: 24 * 30 },
  { key: 'all', label: '全部', hours: null },
];

/** 买卖点标记:买入红色▲,卖出绿色▼,悬停显示交易详情(SVG 原生 title) */
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
        fill={buy ? '#f04848' : '#1db954'}
        stroke="#0f1218"
        strokeWidth={1}
      />
    </g>
  );
}

export default function PnlChart({ snapshots, trades, initialCapital }) {
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

  return (
    <div>
      <div className="filter-row">
        {RANGES.map((r) => (
          <button
            key={r.key}
            className={`chip ${rangeKey === r.key ? 'active' : ''}`}
            onClick={() => setRangeKey(r.key)}
          >
            {r.label}
          </button>
        ))}
        <span className="muted small chart-legend">▲ 买入 ▼ 卖出(悬停看详情)</span>
      </div>

      {!data.length ? (
        <p className="empty">该时间范围内暂无净值数据。</p>
      ) : (
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: 8 }}>
            <CartesianGrid stroke="#2a2f3a" strokeDasharray="3 3" />
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
              stroke="#8a92a6"
              fontSize={12}
            />
            <YAxis
              domain={['auto', 'auto']}
              tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`}
              stroke="#8a92a6"
              fontSize={12}
              width={70}
            />
            <Tooltip
              contentStyle={{ background: '#1a1e27', border: '1px solid #2a2f3a', borderRadius: 8 }}
              labelFormatter={(t) => new Date(t).toLocaleString('zh-CN')}
              formatter={(value, name, props) => {
                if (name === 'total') {
                  return [
                    `${fmtMoney(value)}(盈亏 ${fmtMoney(props.payload.pnl)} / ${fmtPercent(props.payload.pnlPercent)})`,
                    '总资产',
                  ];
                }
                return null;
              }}
            />
            {initialCapital && (
              <ReferenceLine
                y={Number(initialCapital)}
                stroke="#8a92a6"
                strokeDasharray="4 4"
                label={{ value: '初始资金', fill: '#8a92a6', fontSize: 12, position: 'insideTopRight' }}
              />
            )}
            <Line
              type="monotone"
              dataKey="total"
              stroke={data[data.length - 1].pnl >= 0 ? '#f04848' : '#1db954'}
              strokeWidth={2}
              dot={false}
            />
            <Scatter data={markers} dataKey="total" shape={<TradeMarker />} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
