import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Card,
  Col,
  Descriptions,
  Empty,
  List,
  Row,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  api,
  fmtTime,
  REGIME_LABELS,
  REGIME_TAG_COLORS,
  MACRO_EVENT_TYPE_LABELS,
} from '../api.js';
import SegmentedBar from './SegmentedBar.jsx';

const DIRECTION_LABELS = { risk_on: '利好风险资产', risk_off: '避险', neutral: '中性' };
const RATES_LABELS = { hawkish: '鹰派', dovish: '鸽派', neutral: '中性' };
const UPDOWN_LABELS = { up: '上行', down: '下行', neutral: '中性' };
const SECTOR_DIR_COLORS = { bullish: 'green', bearish: 'red' };

/** 当前宏观环境卡片:状态 + 风险分 + 利率/通胀/增长子标签 + 确定性核验 + 生效的组合参数 */
function RegimeCard({ regime, marketCheck }) {
  const params = regime?.params || {};
  const riskScore = Number(regime.risk_score ?? 0);
  // 风险分 ∈ [-1,1] → 映射到 [0,100] 填充;方向决定填充色
  const riskTone =
    regime.regime === 'risk_on' ? 'up' : regime.regime === 'neutral' ? 'neutral' : 'down';
  return (
    <Card size="small" title="当前宏观环境">
      <Space size={8} wrap style={{ marginBottom: 12 }}>
        <Tag color={REGIME_TAG_COLORS[regime.regime] || 'default'} style={{ fontSize: 16, padding: '4px 12px' }}>
          {REGIME_LABELS[regime.regime] || regime.regime}
        </Tag>
        {regime.shock_until && (
          <Tag color="red">冲击锁定至 {fmtTime(regime.shock_until)}</Tag>
        )}
        {regime.clamped && (
          <Tag color="orange">市场核验不同向,仓位放大已钳制为中性参数</Tag>
        )}
        {regime.market_stress && (
          <Tag color="orange">市场避险,执行参数已收紧至避险</Tag>
        )}
        {regime.confirmed && (
          <Tag color="red">避险方向获市场印证</Tag>
        )}
      </Space>
      <div style={{ marginBottom: 12, maxWidth: 320 }}>
        <SegmentedBar
          label="风险评分 / RISK SCORE"
          value={(riskScore + 1) / 2}
          max={1}
          segments={12}
          tone={riskTone}
          valueText={riskScore.toFixed(2)}
        />
      </div>
      <Space size={8} wrap style={{ marginBottom: 12 }}>
        <Tag>利率 {RATES_LABELS[regime.rates_signal] || '中性'}</Tag>
        <Tag>通胀 {UPDOWN_LABELS[regime.inflation_signal] || '中性'}</Tag>
        <Tag>增长 {UPDOWN_LABELS[regime.growth_signal] || '中性'}</Tag>
        {marketCheck?.available && (
          <Tag color={REGIME_TAG_COLORS[marketCheck.trend] || 'default'}>
            市场核验 {REGIME_LABELS[marketCheck.trend] || marketCheck.trend}
            {marketCheck.spy_price !== null && marketCheck.sma20 !== null
              ? `(SPY $${marketCheck.spy_price} / 20日线 $${marketCheck.sma20}${marketCheck.vix !== null ? ` · VIX ${marketCheck.vix}` : ''})`
              : ''}
          </Tag>
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
          更新于 {fmtTime(regime.updated_at)}
        </Typography.Text>
      </Space>
      {/* 垂直布局 + 标签不换行:水平布局在窄列里"标签: 值"会被折行,观感破碎 */}
      <Descriptions
        size="small"
        layout="vertical"
        column={{ xs: 2, sm: 4 }}
        labelStyle={{ whiteSpace: 'nowrap' }}
        contentStyle={{ whiteSpace: 'nowrap' }}
        items={[
          {
            key: 'budget',
            label: '当日买入预算',
            children: <span className="num">{Math.round((params.daily_buy_budget ?? 0) * 100)}%</span>,
          },
          {
            key: 'reserve',
            label: '现金保留下限',
            children: <span className="num">{Math.round((params.min_cash_reserve ?? 0) * 100)}%</span>,
          },
          {
            key: 'exposure',
            label: '总敞口上限',
            children: <span className="num">{Math.round((params.max_gross_exposure ?? 0) * 100)}%</span>,
          },
          {
            key: 'mult',
            label: '买入宏观乘数',
            children: <span className="num">×{params.macro_multiplier ?? 1}</span>,
          },
        ]}
      />
    </Card>
  );
}

/** 经济日历卡片:即将发布的高重要性数据 + 黑窗状态 */
function CalendarCard({ calendar }) {
  if (!calendar?.available) {
    return (
      <Card size="small" title="经济日历">
        <Alert
          type="info"
          message="经济日历不可用"
          description="当前数据套餐不含经济日历,数据发布黑窗保护未启用;宏观新闻分析与候选池不受影响。"
        />
      </Card>
    );
  }
  const columns = [
    { title: '事件', dataIndex: 'event', ellipsis: true },
    { title: '发布时间', dataIndex: 'date', width: 150, render: (v) => fmtTime(v) },
    { title: '预期', dataIndex: 'estimate', width: 80, align: 'right', render: (v) => (v ?? '—') },
    { title: '前值', dataIndex: 'previous', width: 80, align: 'right', render: (v) => (v ?? '—') },
    { title: '实际', dataIndex: 'actual', width: 80, align: 'right', render: (v) => (v ?? '—') },
  ];
  return (
    <Card
      size="small"
      title={
        <Space size={8}>
          经济日历
          {calendar.blackout?.active && (
            <Badge status="error" text={`数据发布黑窗中(至 ${fmtTime(calendar.blackout.until)})`} />
          )}
        </Space>
      }
    >
      {calendar.upcoming?.length ? (
        <Table
          rowKey={(r) => `${r.event}-${r.date}`}
          size="small"
          columns={columns}
          dataSource={calendar.upcoming}
          pagination={false}
          scroll={{ x: 560 }}
        />
      ) : (
        <Empty description="近期没有高重要性美国经济数据发布" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}
    </Card>
  );
}

/** 近期宏观事件列表 */
function MacroEventsList({ events }) {
  return (
    <Card size="small" title="近期宏观事件">
      {events?.length ? (
        <List
          size="small"
          dataSource={events}
          renderItem={(ev) => (
            <List.Item style={{ display: 'block' }}>
              <Space size={6} wrap>
                <Tag>{MACRO_EVENT_TYPE_LABELS[ev.event_type] || ev.event_type}</Tag>
                <Tag
                  color={
                    ev.macro_direction === 'risk_on'
                      ? 'green'
                      : ev.macro_direction === 'risk_off'
                        ? 'red'
                        : 'default'
                  }
                  style={{ marginRight: 0 }}
                >
                  {DIRECTION_LABELS[ev.macro_direction]}
                </Tag>
                <Tag color={ev.market_impact_tier === 1 ? 'red' : ev.market_impact_tier === 2 ? 'orange' : 'default'}>
                  第{ev.market_impact_tier}档
                </Tag>
                {ev.has_actual && <Tag>实际 {ev.actual}{ev.surprise != null ? ` · 意外 ${(ev.surprise * 100).toFixed(1)}%` : ''}</Tag>}
                {(() => {
                  const reports = ev.source_count ?? ev.article_count ?? 0;
                  return reports > 1 ? <Tag color="blue">×{reports} 篇报道</Tag> : null;
                })()}
                {ev.risk_contribution != null && Math.abs(ev.risk_contribution) >= 0.005 && (
                  <Tag className={ev.risk_contribution >= 0 ? 'up' : 'down'} bordered={false}>
                    贡献 {ev.risk_contribution >= 0 ? '+' : ''}{ev.risk_contribution.toFixed(2)}
                  </Tag>
                )}
                {(ev.affected_sectors || []).map((s) => (
                  <Tag key={s.sector} color={SECTOR_DIR_COLORS[s.direction]}>
                    {s.sector}
                  </Tag>
                ))}
                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                  {fmtTime(ev.created_at)}
                </Typography.Text>
              </Space>
              {ev.summary && (
                <Typography.Paragraph style={{ fontSize: 13, margin: '4px 0 0' }}>
                  {ev.summary}
                </Typography.Paragraph>
              )}
            </List.Item>
          )}
        />
      ) : (
        <Empty description="暂无宏观事件。综合财经新闻经分析后会在此累积。" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}
    </Card>
  );
}

/**
 * 宏观页:当前市场环境(regime)、经济日历与黑窗、近期宏观事件。
 * 买入候选池在「交易记录」页展示。
 * version 由 App 的 SSE macro 事件驱动自增,触发重新拉取。
 */
export default function MacroPage({ version = 0 }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.macro());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load, version]);

  if (loading && !data) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </div>
    );
  }
  if (error) return <Alert type="error" message={error} />;
  if (!data || data.available === false) {
    return (
      <Alert
        type="info"
        message="宏观功能尚未启用"
        description="数据库还没有宏观信号层相关表(014 迁移),执行迁移后系统会自动开始累积宏观事件与候选池数据。"
      />
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={10}>
          <RegimeCard regime={data.regime} marketCheck={data.market_check} />
        </Col>
        <Col xs={24} lg={14}>
          <CalendarCard calendar={data.calendar} />
        </Col>
      </Row>
      <MacroEventsList events={data.events} />
      <Typography.Paragraph type="secondary" style={{ fontSize: 13, margin: 0 }}>
        宏观环境以「事件」而非「报道篇数」为风险单位:一次数据发布(如 CPI)无论被几篇新闻报道只计一次贡献;
        经济日历负责数值事实与意外幅度,宏观新闻负责方向与解释,二者汇入同一事件。风险分由近 72 小时的事件按档位、
        意外幅度、置信度、来源可信度与时间衰减加权聚合:避险/冲击状态下收紧当日预算、
        提高现金保留并压缩买入金额;利好信号统一进入买入候选池(见「交易记录」页),
        由资金分配器在盘中按分数高低分配资金——资金不足的高分信号会留池等待,
        而不是先到先得地被低分信号抢走。
      </Typography.Paragraph>
    </Space>
  );
}
