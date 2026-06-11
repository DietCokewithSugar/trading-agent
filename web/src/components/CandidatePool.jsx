import React, { useEffect, useState } from 'react';
import { Button, Card, Empty, Space, Table, Tag } from 'antd';
import { api, fmtNum, fmtTime, CANDIDATE_STATUS_LABELS, TIER_LABELS } from '../api.js';

const CANDIDATE_STATUS_COLORS = {
  pending: 'blue',
  capital_constrained: 'gold',
  macro_filtered: 'orange',
  conflict_hold: 'purple',
};

// status_reason 为空时(常见于刚入池的待分配候选)按状态给出默认说明,避免「说明」列空白
const STATUS_FALLBACK_NOTES = {
  pending: '等待资金分配器盘中按分数执行',
  capital_constrained: '资金暂不足,留池等待资金释放后复评',
  macro_filtered: '被当前宏观环境过滤,环境改善后自动复评',
  conflict_hold: '存在反向信号,冲突解除后自动复评',
};

/**
 * 买入候选池:通过准入门槛、等待资金分配器盘中统一执行的利好信号。
 * version 由 App 的 SSE macro 事件(含池数量变化)驱动自增,触发重新拉取;
 * 候选池不可用(未启用宏观层/014 迁移未执行)时整体隐藏。
 */
export default function CandidatePool({ version = 0, onSymbolClick }) {
  const [pool, setPool] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .pool()
      .then((data) => !cancelled && setPool(data?.pool ?? null))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [version]);

  if (!pool) return null;
  const counts = pool.counts || {};
  const columns = [
    {
      title: '股票',
      dataIndex: 'symbol',
      width: 90,
      render: (v) => (
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => onSymbolClick?.(v)}>
          {v}
        </Button>
      ),
    },
    {
      title: '档位',
      dataIndex: 'tier',
      width: 160,
      ellipsis: true,
      render: (v) => (v ? TIER_LABELS[v] : '—'),
    },
    {
      title: '当前分',
      dataIndex: 'current_score',
      width: 90,
      align: 'right',
      render: (v) => <span className="num">{v === null || v === undefined ? '—' : fmtNum(v, 3)}</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v) => (
        <Tag color={CANDIDATE_STATUS_COLORS[v] || 'default'} style={{ marginRight: 0 }}>
          {CANDIDATE_STATUS_LABELS[v] || v}
        </Tag>
      ),
    },
    {
      title: '说明',
      dataIndex: 'status_reason',
      ellipsis: true,
      render: (v, row) => v || STATUS_FALLBACK_NOTES[row.status] || '—',
    },
    { title: '入池时间', dataIndex: 'created_at', width: 110, render: (v) => fmtTime(v) },
  ];
  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={
        <Space size={8} wrap>
          买入候选池
          {Object.entries(counts).map(([status, n]) => (
            <Tag key={status} color={CANDIDATE_STATUS_COLORS[status] || 'default'} style={{ marginRight: 0 }}>
              {CANDIDATE_STATUS_LABELS[status] || status} {n}
            </Tag>
          ))}
        </Space>
      }
    >
      {pool.top?.length ? (
        <Table
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={pool.top}
          pagination={false}
          scroll={{ x: 700 }}
        />
      ) : (
        <Empty
          description="候选池为空。利好信号经准入门槛后入池,由资金分配器在盘中按分数统一执行。"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      )}
    </Card>
  );
}
