import React from 'react';
import { Tag } from 'antd';
import { fmtPercent, SESSION_LABELS } from '../api.js';

/**
 * 非常规时段徽标:盘前/盘后/休市 + 盘外涨跌幅(相对常规收盘价)。
 * 持仓表与候选池共用,保证两处的显示口径永远一致;
 * 无盘外价(extendedPrice == null)或盘中时段不渲染。
 */
export default function SessionBadge({ session, extendedPrice, extendedChangePercent }) {
  if (!session || session === 'regular' || extendedPrice == null) return null;
  return (
    <Tag color="orange" style={{ marginRight: 0 }}>
      {SESSION_LABELS[session] || session}
      {extendedChangePercent != null && ` ${fmtPercent(extendedChangePercent)}`}
    </Tag>
  );
}
