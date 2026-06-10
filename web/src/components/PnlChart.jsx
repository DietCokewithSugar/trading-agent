import React from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  CartesianGrid,
} from 'recharts';
import { fmtMoney, fmtPercent } from '../api.js';

export default function PnlChart({ snapshots, initialCapital }) {
  if (!snapshots?.length) {
    return <p className="empty">暂无净值数据。系统每轮运行后会自动记录一次快照。</p>;
  }

  const data = snapshots.map((s) => ({
    time: new Date(s.created_at).getTime(),
    total: Number(s.total_value),
    pnl: Number(s.pnl),
    pnlPercent: Number(s.pnl_percent),
  }));

  const last = data[data.length - 1];
  const lineColor = last.pnl >= 0 ? '#f04848' : '#1db954';

  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid stroke="#2a2f3a" strokeDasharray="3 3" />
        <XAxis
          dataKey="time"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(t) =>
            new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
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
            return [fmtMoney(value), name];
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
        <Line type="monotone" dataKey="total" stroke={lineColor} strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
