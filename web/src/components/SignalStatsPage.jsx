import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Row, Space, Spin, Statistic, Table, Typography } from 'antd';

import { api } from '../api.js';

const HORIZONS = [
  { key: '1h', label: '1 小时' },
  { key: '1d', label: '1 个交易日' },
  { key: '5d', label: '5 个交易日' },
];

function fmtSignedPct(v, digits = 2) {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

/** 一组分桶的统计表:每个口径展示 样本数 / 方向命中率 / 平均收益 */
function GroupTable({ group }) {
  const columns = [
    { title: '分组', dataIndex: 'label', fixed: 'left', width: 150 },
    ...HORIZONS.map((h) => ({
      title: h.label,
      children: [
        {
          title: '样本',
          dataIndex: `n_${h.key}`,
          width: 70,
          align: 'right',
          render: (v) => <span className="num">{v ?? 0}</span>,
        },
        {
          title: '命中率',
          dataIndex: `hit_${h.key}`,
          width: 85,
          align: 'right',
          render: (v) =>
            v === null || v === undefined ? (
              '—'
            ) : (
              <span className={`num ${v >= 55 ? 'up' : v < 45 ? 'down' : ''}`}>{v.toFixed(0)}%</span>
            ),
        },
        {
          title: '平均收益',
          dataIndex: `avg_${h.key}`,
          width: 95,
          align: 'right',
          render: (v) =>
            v === null || v === undefined ? (
              '—'
            ) : (
              <span className={`num ${v > 0 ? 'up' : v < 0 ? 'down' : ''}`}>{fmtSignedPct(v)}</span>
            ),
        },
      ],
    })),
  ];
  return (
    <Card title={group.label} size="small">
      <Table
        rowKey="label"
        size="small"
        columns={columns}
        dataSource={group.rows}
        pagination={false}
        scroll={{ x: 760 }}
      />
    </Card>
  );
}

/**
 * 信号质量页:评估"分析信号本身"的预测能力,与仓位/止损/组合表现解耦。
 * 统计覆盖全部记录了信号价的非中性信号,包括因事件去重、置信度不足
 * 而未实际交易的信号;收益按信号方向调整(利空信号下跌计为正)。
 */
export default function SignalStatsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.signalStats());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !data) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </div>
    );
  }
  if (error) return <Alert type="error" message={error} />;
  if (data && data.available === false) {
    return (
      <Alert
        type="info"
        message="信号评估数据尚未启用"
        description="数据库还没有信号前瞻收益相关字段(011 迁移),执行迁移后系统会自动开始积累评估数据。"
      />
    );
  }
  if (!data || !data.total) {
    return <Empty description="暂无信号样本。信号产生 1 小时后开始回填前瞻收益,随后在此汇总。" />;
  }

  const headerCards = [
    { title: '信号样本', value: <span className="num">{data.total}</span> },
    {
      title: '其中实际交易',
      value: <span className="num">{data.traded_count}</span>,
    },
    ...HORIZONS.map((h) => ({
      title: `IC(${h.label})`,
      value:
        data.ic?.[h.key] === null || data.ic?.[h.key] === undefined ? (
          '—'
        ) : (
          <span className={`num ${data.ic[h.key] > 0 ? 'up' : 'down'}`}>{data.ic[h.key].toFixed(3)}</span>
        ),
    })),
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[12, 12]} align="middle">
        {headerCards.map((c) => (
          <Col xs={12} sm={8} md={4} key={c.title}>
            <Card size="small">
              <Statistic title={c.title} valueRender={() => c.value} valueStyle={{ fontSize: 20 }} />
            </Card>
          </Col>
        ))}
        <Col flex="auto" style={{ textAlign: 'right' }}>
          <Button onClick={load} loading={loading}>
            刷新
          </Button>
        </Col>
      </Row>

      <Typography.Paragraph type="secondary" style={{ fontSize: 13, margin: 0 }}>
        本页评估的是「分析信号本身」的预测能力,与仓位大小、止损、组合表现解耦:统计覆盖全部非中性信号
        (含因事件去重、置信度不足而未实际交易的),前瞻收益按信号方向调整(利空信号对应股价下跌计为命中),
        IC 为综合置信度与方向调整收益的相关系数——IC 持续为正且置信度分桶的命中率单调上升,才说明信号有可用的
        alpha,而不只是赶上了好行情。
      </Typography.Paragraph>

      {data.groups.map((g) => (
        <GroupTable key={g.key} group={g} />
      ))}
    </Space>
  );
}
