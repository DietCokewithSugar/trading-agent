import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Row, Segmented, Space, Spin, Statistic, Table, Typography } from 'antd';

import { api, fmtTime } from '../api.js';

// ±2%/48h 策略下的三个决策口径:1h(即时反应)、1d(次日定型)、
// 2d(≈48 小时,与持有上限对齐——持仓到期时信号方向是否兑现)。
// 旧 5d 口径与策略盈亏几乎无关且成熟期太长(采样窗口内几乎无样本),031 起停用
const HORIZONS = [
  { key: '1h', label: '1 小时' },
  { key: '1d', label: '1 个交易日' },
  { key: '2d', label: '2 个交易日(≈48h)' },
];

const RANGES = [
  { key: '7d', label: '7天', days: 7 },
  { key: '30d', label: '30天', days: 30 },
  { key: 'all', label: '全部', days: null },
];

function fmtSignedPct(v, digits = 2) {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

/**
 * 命中率单元格:数值按统计显著性着色(95% 置信区间整体高于 50% 才算"显著好",
 * 整体低于 50% 才算"显著差",区间跨过 50% 一律中性——小样本不下结论),
 * 区间本身以小字标注在数值下方。
 */
function HitCell({ value, lo, hi }) {
  if (value === null || value === undefined) return '—';
  const tone = lo !== null && lo !== undefined && lo > 50 ? 'up' : hi !== null && hi !== undefined && hi < 50 ? 'down' : '';
  return (
    <span className="num">
      <span className={tone}>{value.toFixed(0)}%</span>
      {lo !== null && lo !== undefined && (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.2 }}>
          {lo.toFixed(0)}~{hi.toFixed(0)}
        </div>
      )}
    </span>
  );
}

/** 一组分桶的统计表:每个口径展示 样本数 / 方向命中率(95% 区间)/ 平均收益 */
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
          width: 95,
          align: 'right',
          render: (v, row) => (
            <HitCell value={v} lo={row[`hit_lo_${h.key}`]} hi={row[`hit_hi_${h.key}`]} />
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
        scroll={{ x: 790 }}
      />
    </Card>
  );
}

/** 实盘兑现表:每笔平仓按源信号维度分桶,展示 ±2%/48h 离场规则下的触发分布与已实现盈亏 */
function OutcomesTable({ outcomes }) {
  if (!outcomes || !outcomes.total) return null;
  const ratePct = (v) => (v === null || v === undefined ? '—' : <span className="num">{v.toFixed(0)}%</span>);
  const columns = [
    { title: '分组', dataIndex: 'label', fixed: 'left', width: 150 },
    { title: '平仓笔数', dataIndex: 'n', width: 80, align: 'right', render: (v) => <span className="num">{v}</span> },
    { title: '止盈', dataIndex: 'take_profit_rate', width: 70, align: 'right', render: ratePct },
    { title: '止损', dataIndex: 'stop_loss_rate', width: 70, align: 'right', render: ratePct },
    { title: '持有超时', dataIndex: 'max_hold_rate', width: 85, align: 'right', render: ratePct },
    { title: '其他', dataIndex: 'other_rate', width: 70, align: 'right', render: ratePct },
    {
      title: '胜率',
      dataIndex: 'win_rate',
      width: 95,
      align: 'right',
      render: (v, row) => <HitCell value={v} lo={row.win_lo} hi={row.win_hi} />,
    },
    {
      title: '平均盈亏($)',
      dataIndex: 'avg_pnl',
      width: 100,
      align: 'right',
      render: (v) =>
        v === null || v === undefined ? (
          '—'
        ) : (
          <span className={`num ${v > 0 ? 'up' : v < 0 ? 'down' : ''}`}>{v >= 0 ? '+' : ''}{v.toFixed(2)}</span>
        ),
    },
  ];
  return (
    <Card title="实盘兑现(±2%/48h 离场分布)" size="small">
      <Table
        rowKey="label"
        size="small"
        columns={columns}
        dataSource={outcomes.buckets}
        pagination={false}
        scroll={{ x: 720 }}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 13, margin: '8px 0 0' }}>
        每笔平仓按"同票最近一笔买入"回溯其源信号的档位与来源。这是最贴近当前策略的信号质量口径:
        止盈占比高说明该类信号的强度足以在持有时限内兑现 +2%;止损占比过半说明信号与固定敞口不匹配
        (入场噪音大或敞口过窄);持有超时占比高说明信号方向对但动能不足。
      </Typography.Paragraph>
    </Card>
  );
}

/**
 * 信号质量页:评估"分析信号本身"的预测能力,与仓位/止损/组合表现解耦。
 * 统计覆盖全部记录了信号价且至少一个口径已回填的非中性信号,包括因事件去重、
 * 置信度不足而未实际交易的信号;收益按信号方向调整(利空信号下跌计为正)。
 */
export default function SignalStatsPage() {
  const [rangeKey, setRangeKey] = useState('30d');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const range = RANGES.find((r) => r.key === rangeKey);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.signalStats(range.days));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }, [range.days]);

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
    return (
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Segmented
          size="small"
          options={RANGES.map((r) => ({ label: r.label, value: r.key }))}
          value={rangeKey}
          onChange={setRangeKey}
        />
        <Empty description={`${range.days ? `近 ${range.days} 天` : '当前'}暂无信号样本。信号产生 1 小时后开始回填前瞻收益,随后在此汇总。`} />
      </Space>
    );
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
          // 恰为 0 不着色:0 既非正相关也非负相关
          <span className={`num ${data.ic[h.key] > 0 ? 'up' : data.ic[h.key] < 0 ? 'down' : ''}`}>
            {data.ic[h.key].toFixed(3)}
          </span>
        ),
    })),
  ];

  const windowNote = data.window
    ? data.window.days
      ? `统计窗口:近 ${data.window.days} 天`
      : '统计窗口:全部历史'
    : null;

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
          <Space>
            <Segmented
              size="small"
              options={RANGES.map((r) => ({ label: r.label, value: r.key }))}
              value={rangeKey}
              onChange={setRangeKey}
            />
            <Button onClick={load} loading={loading}>
              刷新
            </Button>
          </Space>
        </Col>
      </Row>

      {data.window?.truncated && (
        <Alert
          type="warning"
          showIcon
          message={`样本量达到上限 ${data.window.max_rows} 条,实际只覆盖到 ${fmtTime(data.window.covered_since)} 之后的信号——更早的信号未计入,请缩小时间范围查看完整窗口。`}
        />
      )}

      <Typography.Paragraph type="secondary" style={{ fontSize: 13, margin: 0 }}>
        {windowNote ? `${windowNote} · 样本 ${data.total} 条。` : ''}
        本页评估的是「分析信号本身」的预测能力,与仓位大小、止损、组合表现解耦:统计覆盖全部非中性信号
        (含因事件去重、置信度不足而未实际交易的),样本只计入至少回填了一个口径的信号——刚产生、
        前瞻收益尚未到期的新信号不占样本预算。前瞻收益按信号方向调整(利空信号对应股价下跌计为命中),
        IC 为综合置信度与方向调整收益的相关系数——IC 持续为正且置信度分桶的命中率单调上升,才说明信号有可用的
        alpha,而不只是赶上了好行情。命中率下方的小字为 Wilson 95% 置信区间,数值仅在区间整体高于(绿)或
        低于(红)50% 时着色——区间跨过 50% 说明样本还不足以下结论。「实际交易 vs 拦截层」是各防线的机会成本:
        被宏观过滤/风控官否决/资金受限拦下的信号若持续跑出正收益,说明该层过度保守;若为负,说明该层在创造价值。
        「实盘兑现」是 ±2%/48h 离场规则下的信号兑现质量,是当前策略最直接的观测口径。
      </Typography.Paragraph>

      <OutcomesTable outcomes={data.outcomes} />

      {data.pooling && data.pooling.n > 0 && (
        <Card title="候选池排队成本(入池路径成交)" size="small">
          <Row gutter={[12, 12]}>
            <Col xs={8}>
              <Statistic title="样本数" valueRender={() => <span className="num">{data.pooling.n}</span>} valueStyle={{ fontSize: 20 }} />
            </Col>
            <Col xs={8}>
              <Statistic
                title="平均等待"
                valueRender={() => (
                  <span className="num">
                    {data.pooling.avg_wait_minutes === null ? '—' : `${data.pooling.avg_wait_minutes} 分钟`}
                  </span>
                )}
                valueStyle={{ fontSize: 20 }}
              />
            </Col>
            <Col xs={8}>
              <Statistic
                title="平均入池→成交漂移"
                valueRender={() =>
                  data.pooling.avg_drift_percent === null ? (
                    '—'
                  ) : (
                    <span className={`num ${data.pooling.avg_drift_percent > 0 ? 'down' : 'up'}`}>
                      {fmtSignedPct(data.pooling.avg_drift_percent)}
                    </span>
                  )
                }
                valueStyle={{ fontSize: 20 }}
              />
            </Col>
          </Row>
          <Typography.Paragraph type="secondary" style={{ fontSize: 13, margin: '8px 0 0' }}>
            漂移为正表示排队期间价格上行、买得更贵(排队成本);对比上方「执行路径与排队时长」分桶的
            1 小时收益,可量化候选池延迟换来的资金分配是否抵得过信号变陈旧。
          </Typography.Paragraph>
        </Card>
      )}

      {data.groups.map((g) => (
        <GroupTable key={g.key} group={g} />
      ))}
    </Space>
  );
}
