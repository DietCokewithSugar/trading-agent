import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Empty,
  Row,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  api,
  fmtTime,
  etToday,
  REGIME_LABELS,
  REGIME_TAG_COLORS,
  MACRO_EVENT_TYPE_LABELS,
} from '../api.js';
import SegmentedBar from './SegmentedBar.jsx';
import MacroHeatmap from './MacroHeatmap.jsx';

const DIRECTION_LABELS = { risk_on: '利好风险资产', risk_off: '避险', neutral: '中性' };
const RATES_LABELS = { hawkish: '鹰派', dovish: '鸽派', neutral: '中性' };
const UPDOWN_LABELS = { up: '上行', down: '下行', neutral: '中性' };
const SECTOR_DIR_COLORS = { bullish: 'green', bearish: 'red' };

const fmtDayLabel = (d) => dayjs(d).format('M月D日');

/**
 * 宏观环境卡片:状态 + 风险分 + 利率/通胀/增长子标签 + 确定性核验 + 生效的组合参数。
 * historical 模式为按当日事件的回溯推算:无市场核验/钳制(两者是"现在"语义),
 * 参数为该 regime 对应的预设(非当日实际生效值)。
 */
function RegimeCard({ regime, marketCheck, historical, date }) {
  const params = regime?.params || {};
  const riskScore = Number(regime.risk_score ?? 0);
  // 风险分 ∈ [-1,1] → 映射到 [0,100] 填充;方向决定填充色
  const riskTone =
    regime.regime === 'risk_on' ? 'up' : regime.regime === 'neutral' ? 'neutral' : 'down';
  return (
    <Card
      size="small"
      title={historical ? `${fmtDayLabel(date)} 宏观环境` : '当前宏观环境'}
      style={{ height: '100%' }}
    >
      <Space size={8} wrap style={{ marginBottom: 12 }}>
        <Tag color={REGIME_TAG_COLORS[regime.regime] || 'default'} style={{ fontSize: 16, padding: '4px 12px' }}>
          {REGIME_LABELS[regime.regime] || regime.regime}
        </Tag>
        {historical && (
          <Tooltip title="按当日事件用与实时相同的聚合规则回溯推算,不含确定性市场核验">
            <Tag bordered className="label-caps" style={{ marginRight: 0 }}>
              回溯推算
            </Tag>
          </Tooltip>
        )}
        {regime.shock_until && (
          <Tag color="red">冲击锁定至 {fmtTime(regime.shock_until)}</Tag>
        )}
        {!historical && regime.clamped && (
          <Tag color="orange">市场核验不同向,仓位放大已钳制为中性参数</Tag>
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
        {!historical && marketCheck?.available && (
          <Tag color={REGIME_TAG_COLORS[marketCheck.trend] || 'default'}>
            市场核验 {REGIME_LABELS[marketCheck.trend] || marketCheck.trend}
            {marketCheck.spy_price !== null && marketCheck.sma20 !== null
              ? `(SPY $${marketCheck.spy_price} / 20日线 $${marketCheck.sma20}${marketCheck.vix !== null ? ` · VIX ${marketCheck.vix}` : ''})`
              : ''}
          </Tag>
        )}
        {!historical && (
          <Typography.Text type="secondary" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
            更新于 {fmtTime(regime.updated_at)}
          </Typography.Text>
        )}
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

/** 经济日历卡片:实时为即将发布的高重要性数据 + 黑窗状态;历史为选中日的实际发布记录 */
function CalendarCard({ calendar, historical, date }) {
  const title = historical ? `${fmtDayLabel(date)} 经济日历` : '经济日历';
  if (!calendar?.available) {
    return (
      <Card size="small" title={title} style={{ height: '100%' }}>
        <Alert
          type="info"
          message={historical ? '当日经济日历不可用' : '经济日历不可用'}
          description={
            historical
              ? '当前数据套餐不含经济日历,或该日数据拉取失败;宏观环境与事件回溯不受影响。'
              : '当前数据套餐不含经济日历,数据发布黑窗保护未启用;宏观新闻分析与候选池不受影响。'
          }
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
      style={{ height: '100%' }}
      title={
        <Space size={8}>
          {title}
          {!historical && calendar.blackout?.active && (
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
          // y 定高内部滚动:与左侧宏观环境卡保持等高,长日历不再把卡片撑高
          scroll={{ x: 560, y: 236 }}
        />
      ) : (
        <Empty
          description={historical ? '当日没有高重要性美国经济数据发布' : '近期没有高重要性美国经济数据发布'}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      )}
    </Card>
  );
}

/**
 * 宏观事件表(跟随日期筛选):紧凑单行 + 摘要省略,点击行展开完整摘要与受影响板块。
 * 全站约定:长列表用数据密集型表格,不用卡片堆叠。
 */
function MacroEventsTable({ events, historical, date }) {
  const rows = events || [];
  const columns = [
    {
      title: '时间',
      dataIndex: 'created_at',
      width: 120,
      render: (v) => <span className="num">{fmtTime(v)}</span>,
    },
    {
      title: '类型',
      dataIndex: 'event_type',
      width: 110,
      render: (v) => <Tag style={{ marginRight: 0 }}>{MACRO_EVENT_TYPE_LABELS[v] || v}</Tag>,
    },
    {
      title: '方向',
      dataIndex: 'macro_direction',
      width: 110,
      render: (v) => (
        <Tag
          color={v === 'risk_on' ? 'green' : v === 'risk_off' ? 'red' : 'default'}
          style={{ marginRight: 0 }}
        >
          {DIRECTION_LABELS[v] || v}
        </Tag>
      ),
    },
    {
      title: '档位',
      dataIndex: 'market_impact_tier',
      width: 76,
      render: (v) => (
        <Tag color={v === 1 ? 'red' : v === 2 ? 'orange' : 'default'} style={{ marginRight: 0 }}>
          第{v}档
        </Tag>
      ),
    },
    {
      title: '报道',
      dataIndex: 'article_count',
      width: 64,
      align: 'right',
      render: (v) => <span className="num">×{v || 1}</span>,
    },
    { title: '摘要', dataIndex: 'summary', ellipsis: true, render: (v) => v || '—' },
  ];
  return (
    <Card
      size="small"
      title={
        historical
          ? `${fmtDayLabel(date)} 宏观事件 (${rows.length})`
          : `近期宏观事件(72 小时) (${rows.length})`
      }
    >
      {rows.length ? (
        <Table
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 760 }}
          expandable={{
            rowExpandable: (r) => Boolean(r.summary || r.affected_sectors?.length),
            expandedRowRender: (r) => (
              <div>
                {r.summary && (
                  <Typography.Paragraph style={{ fontSize: 13, margin: 0 }}>
                    {r.summary}
                  </Typography.Paragraph>
                )}
                {Boolean(r.affected_sectors?.length) && (
                  <Space size={6} wrap style={{ marginTop: r.summary ? 8 : 0 }}>
                    {r.affected_sectors.map((s) => (
                      <Tag key={s.sector} color={SECTOR_DIR_COLORS[s.direction]} style={{ marginRight: 0 }}>
                        {s.sector}
                      </Tag>
                    ))}
                  </Space>
                )}
              </div>
            ),
          }}
        />
      ) : (
        <Empty
          description={
            historical ? '当日无宏观事件记录。' : '暂无宏观事件。综合财经新闻经分析后会在此累积。'
          }
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      )}
    </Card>
  );
}

/**
 * 宏观页:市场环境(regime)、经济日历与黑窗、宏观事件。
 * 顶部热力图/日期筛选可回看任意历史日(regime 按当日事件回溯推算,日历为当日实际发布),
 * 选中历史日时 SSE 刷新不打扰;买入候选池在「交易记录」页展示。
 * version 由 App 的 SSE macro 事件驱动自增,触发重新拉取(仅实时视图)。
 */
export default function MacroPage({ version = 0 }) {
  const [data, setData] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // 选中的美东日(YYYY-MM-DD);null = 实时视图(今日)
  const [selectedDate, setSelectedDate] = useState(null);

  const load = useCallback(async (date) => {
    setLoading(true);
    try {
      setData(await api.macro(date || undefined));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }, []);

  // 日期切换即刻重拉;SSE version 只刷新实时视图(历史日数据不可变,不被推送打扰)
  useEffect(() => {
    if (selectedDate) load(selectedDate);
  }, [load, selectedDate]);
  useEffect(() => {
    if (!selectedDate) load(null);
  }, [load, selectedDate, version]);

  // 热力图序列:挂载时拉一次,宏观事件推送时刷新(服务端缓存 10 分钟,开销很小)
  useEffect(() => {
    api
      .macroHistory()
      .then(setHistory)
      .catch(() => setHistory(null));
  }, [version]);

  // 选择语义:今日/清除 → 回实时视图
  const selectDay = (value) => {
    const key = value && dayjs.isDayjs(value) ? value.format('YYYY-MM-DD') : value;
    setSelectedDate(key && key < etToday() ? key : null);
  };
  const stepDay = (delta) => {
    const base = dayjs(selectedDate || etToday()).add(delta, 'day');
    selectDay(base.format('YYYY-MM-DD'));
  };

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

  const historical = data.mode === 'historical';
  const todayEt = etToday();

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {history?.available && (
        <Card
          size="small"
          title="宏观环境日历"
          extra={
            <Space.Compact size="small">
              <Button icon={<LeftOutlined />} onClick={() => stepDay(-1)} title="前一天" />
              <DatePicker
                size="small"
                value={dayjs(selectedDate || todayEt)}
                onChange={selectDay}
                allowClear={Boolean(selectedDate)}
                disabledDate={(d) => d.format('YYYY-MM-DD') > todayEt}
                style={{ width: 130 }}
              />
              <Button
                icon={<RightOutlined />}
                onClick={() => stepDay(1)}
                disabled={!selectedDate}
                title="后一天"
              />
            </Space.Compact>
          }
        >
          <MacroHeatmap
            history={history.days}
            selectedDate={selectedDate}
            onSelect={selectDay}
            todayEt={todayEt}
            live={
              !historical && data.regime
                ? { regime: data.regime.regime, risk_score: data.regime.risk_score }
                : null
            }
          />
        </Card>
      )}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={10}>
          <RegimeCard
            regime={data.regime}
            marketCheck={data.market_check}
            historical={historical}
            date={data.date}
          />
        </Col>
        <Col xs={24} lg={14}>
          <CalendarCard calendar={data.calendar} historical={historical} date={data.date} />
        </Col>
      </Row>
      <MacroEventsTable events={data.events} historical={historical} date={data.date} />
      <Typography.Paragraph type="secondary" style={{ fontSize: 13, margin: 0 }}>
        宏观环境由近 72 小时的宏观事件按档位、置信度与时间衰减加权聚合:避险/冲击状态下收紧当日预算、
        提高现金保留并压缩买入金额;利好信号统一进入买入候选池(见「交易记录」页),
        由资金分配器在盘中按分数高低分配资金——资金不足的高分信号会留池等待,
        而不是先到先得地被低分信号抢走。历史日的环境为按当日事件回溯推算(与实时同一套聚合规则,
        不含确定性市场核验),经济日历为当日实际发布值。
      </Typography.Paragraph>
    </Space>
  );
}
