import React, { useEffect, useState } from 'react';
import {
  Alert,
  Card,
  Col,
  Descriptions,
  Empty,
  Row,
  Segmented,
  Space,
  Spin,
  Table,
  Typography,
} from 'antd';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, fmtNum, fmtPercent, fmtTime, etToday, VALUATION_STATE_LABELS } from '../api.js';
import { useThemeMode } from '../theme-context.jsx';
import { getChart } from '../theme.js';

// 卡片首行「分类:水平」的前缀(与参考看板口径一致:VIX:正常 / 情绪:恐惧 / RSI:超卖…)
const LEVEL_PREFIX = {
  vix: 'VIX',
  fear_greed: '情绪',
  rsi: 'RSI',
  pe_percentile: 'PE',
  drawdown_52w: '回撤',
  crash_25d: '急跌',
};

// 多系列身份色(沿消融页先例:分类色不与盈亏绿/红撞色;VIX 分位用琥珀=警示同源)
const SERIES_COLORS = { ndxPe: '#6B9AC4', spxPe: '#9B8AA6' };

// 操作纪律(静态自省清单,按参考看板口径整理;纯前端文案,不依赖接口)
const DISCIPLINES = [
  {
    group: '买入纪律',
    items: [
      '严格按定投指标执行常规定投,不因行情波动跳过。',
      '极端买入信号 命中(绿)→ 2×;接近(黄)→ 1.5×。',
      '只用闲钱分批买入:不加杠杆、不一次性梭哈、不追盘中冲高。',
    ],
  },
  {
    group: '卖出纪律',
    items: [
      '不因恐慌割肉;下跌阶段优先降低定投倍数,而不是清仓。',
      '估值分位极高(≥85%)时分批减仓,不预测顶部、不满仓豪赌。',
    ],
  },
  {
    group: '心态纪律',
    items: [
      '看板信号只做参考,重大加减仓决定隔夜再执行。',
      '接受错过:宁可少赚,不违反纪律。',
    ],
  },
];

const isNum = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

/** 值 + 单位;缺失显示 — */
function valText(value, unit = '', digits = 2) {
  if (!isNum(value)) return '—';
  return `${fmtNum(value, digits)}${unit}`;
}

/** 带涨跌色的百分比单元格(signed=false 时为中性的分位/位置口径) */
function PctCell({ value, signed = true, colored = true, digits = 2 }) {
  if (!isNum(value)) return <span className="muted">—</span>;
  const v = Number(value);
  const cls = colored ? (v >= 0 ? 'up' : 'down') : '';
  return <span className={`num ${cls}`}>{signed ? fmtPercent(v) : `${fmtNum(v, digits)}%`}</span>;
}

/** 单张极端买入信号卡:状态边框 + 大数值 + 分类/触发条件/双指数明细 */
function SignalCard({ signal }) {
  const s = signal;
  const cardCls =
    s.state === 'triggered'
      ? 'sig-card sig-card--triggered'
      : s.state === 'near'
        ? 'sig-card sig-card--near'
        : 'sig-card';
  const digits = s.key === 'fear_greed' ? 0 : s.key === 'rsi' ? 1 : 2;
  return (
    <div className={cardCls}>
      <div className="sig-card__head">
        <span className="sig-card__name">{s.label}</span>
        <span className={`sig-state sig-state--${s.state}`}>
          {VALUATION_STATE_LABELS[s.state] || s.state}
        </span>
      </div>
      <div className="sig-card__value">{valText(s.value, s.unit, digits)}</div>
      <div className="sig-card__row">
        {LEVEL_PREFIX[s.key] || s.label}:{s.level ?? '—'}
      </div>
      <div className="sig-card__row">
        触发:<span className="num">{s.trigger_text}</span>
      </div>
      {s.per_index && (
        <div className="sig-card__row">
          {s.per_index.map((e, i) => (
            <span key={e.key}>
              {i > 0 && ' · '}
              {e.label} <span className="num">{valText(e.value, s.unit, digits)}</span>
            </span>
          ))}
        </div>
      )}
      <div className="sig-card__meta">{s.meta}</div>
    </div>
  );
}

/** 指数汇总卡(指数指标页):点位 + 日涨跌 + 关键副行 */
function IndexCard({ label, price, changePercent, sub }) {
  return (
    <Card size="small" style={{ height: '100%' }}>
      <span className="label-caps">{label}</span>
      <div className="sig-card__value" style={{ margin: '6px 0 4px' }}>
        {isNum(price) ? fmtNum(price, 2) : '—'}
      </div>
      <Space size={8} wrap>
        <PctCell value={changePercent} />
        <span className="muted small">今日</span>
      </Space>
      {sub && <div className="small muted" style={{ marginTop: 6 }}>{sub}</div>}
    </Card>
  );
}

/** 指数指标视图:三张汇总卡 + 纳指/标普指标矩阵表 */
function IndicatorsView({ data }) {
  const { ndx, spx, vix } = data.indexes;
  const rows = [
    { key: 'chg', metric: '日涨跌', render: (ix) => <PctCell value={ix.change_percent} /> },
    {
      key: 'sma',
      metric: '距 200 日均线',
      render: (ix) => <PctCell value={ix.sma200_gap_percent} />,
    },
    { key: 'dd', metric: '52 周回撤', render: (ix) => <PctCell value={ix.drawdown_52w} /> },
    {
      key: 'range',
      metric: '52 周区间位置',
      render: (ix) => <PctCell value={ix.year_range_position} signed={false} colored={false} digits={0} />,
    },
    {
      key: 'rsi',
      metric: 'RSI(6)',
      render: (ix) => (isNum(ix.rsi6) ? <span className="num">{fmtNum(ix.rsi6, 1)}</span> : <span className="muted">—</span>),
    },
    {
      key: 'crash',
      metric: '近 25 日相对高点',
      render: (ix) => <PctCell value={ix.drop_25d} />,
    },
    {
      key: 'pe',
      metric: 'TTM PE',
      render: (ix) => (isNum(ix.pe) ? <span className="num">{fmtNum(ix.pe, 2)}</span> : <span className="muted">—</span>),
    },
    {
      key: 'pepct',
      metric: 'PE 历史分位',
      render: (ix) => <PctCell value={ix.pe_pct} signed={false} colored={false} digits={0} />,
    },
  ];
  const columns = [
    { title: '指标', dataIndex: 'metric', width: 150 },
    { title: '纳指', key: 'ndx', align: 'right', render: (_, r) => r.render(ndx) },
    { title: '标普', key: 'spx', align: 'right', render: (_, r) => r.render(spx) },
  ];
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[12, 12]}>
        <Col xs={24} md={8}>
          <IndexCard
            label={ndx.label}
            price={ndx.price}
            changePercent={ndx.change_percent}
            sub={
              isNum(ndx.sma200_gap_percent)
                ? `距200日均线 ${fmtPercent(ndx.sma200_gap_percent)}`
                : null
            }
          />
        </Col>
        <Col xs={24} md={8}>
          <IndexCard
            label={spx.label}
            price={spx.price}
            changePercent={spx.change_percent}
            sub={
              isNum(spx.sma200_gap_percent)
                ? `距200日均线 ${fmtPercent(spx.sma200_gap_percent)}`
                : null
            }
          />
        </Col>
        <Col xs={24} md={8}>
          <IndexCard
            label={vix.label}
            price={vix.price}
            changePercent={vix.change_percent}
            sub={[
              vix.level ? `水平:${vix.level}` : null,
              isNum(vix.percentile_5y)
                ? `近${vix.history_years}年分位 ${fmtNum(vix.percentile_5y, 0)}%`
                : null,
            ]
              .filter(Boolean)
              .join(' · ') || null}
          />
        </Col>
      </Row>
      <Card size="small" title="指数指标矩阵">
        <Table
          rowKey="key"
          size="small"
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 420 }}
        />
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '10px 0 0' }}>
          价格与技术指标为纳斯达克综合 / 标普 500 指数口径;PE 及历史分位为纳指 100 / 标普 500
          口径(TTM,分位窗口以外部估值源为准)。
        </Typography.Paragraph>
      </Card>
    </Space>
  );
}

/** 情绪与说明视图:六张信号卡 + 月度 VIX/PE 分位图 */
function SignalsView({ data, mode }) {
  const chart = getChart(mode);
  const months = data.chart?.months || [];
  const chartRows = months.map((m) => ({
    ...m,
    label: m.month ? `${Number(m.month.slice(5))}月` : '—',
  }));
  const hasPeLine = chartRows.some((m) => isNum(m.ndx_pe_pct) || isNum(m.spx_pe_pct));
  const axisTick = { fill: chart.axis, fontSize: 11 };
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title="极端买入信号监控(三档)">
        <Typography.Paragraph type="secondary" style={{ fontSize: 12.5, marginTop: 0 }}>
          每格显示当前值、触发条件;绿=触发(极端买入)、黄=接近触发(进入观察区)。
          无论数值高(如 VIX 飙升)或低(如 RSI 超卖、恐惧贪婪极低),同属「买入机会」逻辑即同色提醒。
        </Typography.Paragraph>
        <Row gutter={[12, 12]}>
          {data.signals.map((s) => (
            <Col xs={24} sm={12} xl={8} key={s.key}>
              <SignalCard signal={s} />
            </Col>
          ))}
        </Row>
      </Card>
      <Card size="small" title={`过去 ${months.length || 6} 个月 VIX 与 PE 分位`}>
        {data.chart?.available ? (
          <>
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={chartRows} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={chart.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={axisTick}
                  tickLine={false}
                  axisLine={{ stroke: chart.grid }}
                />
                <YAxis yAxisId="vix" tick={axisTick} tickLine={false} axisLine={false} width={34} />
                <YAxis
                  yAxisId="pct"
                  orientation="right"
                  domain={[0, 100]}
                  unit="%"
                  tick={axisTick}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                />
                <ChartTooltip
                  contentStyle={{
                    background: chart.tooltipBg,
                    border: `1px solid ${chart.tooltipBorder}`,
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: chart.axis }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar
                  yAxisId="vix"
                  dataKey="vix_avg"
                  name="VIX 月均"
                  fill={chart.benchmark}
                  fillOpacity={0.42}
                  radius={[3, 3, 0, 0]}
                  barSize={18}
                />
                <Line
                  yAxisId="pct"
                  dataKey="vix_pct"
                  name="VIX 分位"
                  stroke={chart.benchmarkGold}
                  strokeWidth={1.6}
                  dot={{ r: 2 }}
                  connectNulls
                />
                <Line
                  yAxisId="pct"
                  dataKey="ndx_pe_pct"
                  name="纳指100 PE 分位"
                  stroke={SERIES_COLORS.ndxPe}
                  strokeWidth={1.6}
                  dot={{ r: 2 }}
                  connectNulls
                />
                <Line
                  yAxisId="pct"
                  dataKey="spx_pe_pct"
                  name="标普 PE 分位"
                  stroke={SERIES_COLORS.spxPe}
                  strokeWidth={1.6}
                  dot={{ r: 2 }}
                  connectNulls
                />
              </ComposedChart>
            </ResponsiveContainer>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '8px 0 0' }}>
              每月平均 VIX 及其在近 {data.indexes?.vix?.history_years ?? 5} 年月均序列中的分位,
              同框展示该月 TTM PE 历史分位(纳指100 / 标普500)。
              {!hasPeLine && ' PE 分位历史随每日快照逐步积累,上线初期该线可能为空。'}
            </Typography.Paragraph>
          </>
        ) : (
          <Empty description="暂无月度序列数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>
    </Space>
  );
}

/** 策略与纪律视图:五档定投倍数 + 今日市场结论 + 操作纪律 */
function StrategyView({ data }) {
  const dca = data.dca || {};
  const conclusion = data.conclusion || {};
  const items = [
    { key: 'valuation', label: '市场估值', children: conclusion.valuation || '—' },
    { key: 'sentiment', label: '市场情绪', children: conclusion.sentiment || '—' },
    { key: 'trend', label: '趋势', children: conclusion.trend || '—' },
    { key: 'advice', label: '今日操作建议', children: conclusion.advice || '—' },
  ];
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title="智能定投策略(估值动能 DCA)">
        <Typography.Paragraph type="secondary" style={{ fontSize: 12.5, marginTop: 0 }}>
          五档投入倍数(0.25×–2×),最低档仍投入、只是极少;由估值分位、情绪与极端买入信号综合评估。
        </Typography.Paragraph>
        <div className="dca-tiers">
          {(dca.tiers || []).map((t) => (
            <div
              key={t.multiplier}
              className={
                t.multiplier === dca.active_multiplier ? 'dca-tier dca-tier--active' : 'dca-tier'
              }
            >
              <span className="dca-tier__mult">{t.multiplier}×</span>
              <span className="dca-tier__label">{t.label}</span>
            </div>
          ))}
        </div>
        <div
          style={{
            marginTop: 14,
            padding: '10px 14px',
            border: '1px dashed var(--border-visible)',
            borderRadius: 10,
          }}
        >
          <Space size={10} wrap align="baseline">
            <span className="label-caps">当前建议投入倍数</span>
            <span className="num" style={{ fontSize: 20, fontWeight: 640, color: 'var(--up)' }}>
              {dca.active_multiplier ?? '—'}×
            </span>
          </Space>
          <div className="small muted" style={{ marginTop: 4 }}>
            {dca.reason || '—'}
          </div>
        </div>
      </Card>
      <Card size="small" title={`今日市场结论(${etToday()})`}>
        <Descriptions
          size="small"
          column={1}
          items={items}
          labelStyle={{ whiteSpace: 'nowrap', minWidth: 96 }}
        />
      </Card>
      <Card size="small" title="我的操作纪律(自省提醒)">
        <Row gutter={[16, 12]}>
          {DISCIPLINES.map((d) => (
            <Col xs={24} md={8} key={d.group}>
              <div className="label-caps" style={{ marginBottom: 6 }}>{d.group}</div>
              <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
                {d.items.map((it) => (
                  <li key={it}>{it}</li>
                ))}
              </ol>
            </Col>
          ))}
        </Row>
      </Card>
    </Space>
  );
}

/**
 * 估值看板页(033):美股估值与情绪监控。
 * 三个子视图:指数指标(纳指/标普/VIX 汇总)、情绪与说明(六张极端买入信号卡 + 月度分位图)、
 * 策略与纪律(五档定投倍数 + 今日结论 + 纪律清单)。数据日频为主(服务端收盘后自动刷新,
 * 页面访问超过缓存期现算),挂载时拉取一次,无需 SSE。
 */
export default function ValuationPage() {
  const { mode } = useThemeMode();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('indicators');

  useEffect(() => {
    let cancelled = false;
    api
      .valuation()
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading && !data) {
    return (
      <div style={{ textAlign: 'center', padding: 48 }}>
        <Spin />
      </div>
    );
  }
  if (error) return <Alert type="error" message={error} />;
  if (!data || data.available === false) {
    return <Alert type="info" message="估值看板未启用" description="服务端已关闭该功能(ENABLE_VALUATION_BOARD)。" />;
  }

  const sourceDown = !data.sources?.sentiment || !data.sources?.valuation;
  const downNames = [
    !data.sources?.sentiment ? '情绪指数' : null,
    !data.sources?.valuation ? '指数估值(PE 分位)' : null,
  ].filter(Boolean);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'indicators', label: '指数指标' },
            { value: 'signals', label: '情绪与说明' },
            { value: 'strategy', label: '策略与纪律' },
          ]}
        />
        <Space size={10} wrap>
          {data.summary?.triggered > 0 && (
            <span className="sig-state sig-state--triggered">触发 {data.summary.triggered}</span>
          )}
          {data.summary?.near > 0 && (
            <span className="sig-state sig-state--near">接近 {data.summary.near}</span>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            最后更新 {fmtTime(data.updated_at)} · 每日美东收盘后自动刷新
          </Typography.Text>
        </Space>
      </div>
      {sourceDown && (
        <Alert
          type="warning"
          message={`部分外部数据源暂不可用:${downNames.join('、')}相关卡片显示「暂无数据」,其余指标不受影响。`}
        />
      )}
      {view === 'indicators' && <IndicatorsView data={data} />}
      {view === 'signals' && <SignalsView data={data} mode={mode} />}
      {view === 'strategy' && <StrategyView data={data} />}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12.5, margin: 0 }}>
        本看板为估值与情绪的观察参考,信号与定投倍数由确定性规则计算,不构成投资建议,
        也不参与本站模拟交易的任何决策链路。
      </Typography.Paragraph>
    </Space>
  );
}
