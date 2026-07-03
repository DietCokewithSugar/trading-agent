import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Segmented,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  CartesianGrid,
  Legend,
} from 'recharts';
import {
  api,
  fmtMoney,
  fmtNum,
  fmtPercent,
  fmtTime,
  SHADOW_VARIANT_LABELS,
  SHADOW_VARIANT_DESCRIPTIONS,
  TRIGGER_LABELS,
} from '../api.js';
import { getChart, getPnl, ACCENT_PRIMARY } from '../theme.js';
import { useThemeMode } from '../theme-context.jsx';

const RANGES = [
  { key: '1d', label: '1天', hours: 24 },
  { key: '1w', label: '1周', hours: 24 * 7 },
  { key: '1m', label: '1月', hours: 24 * 30 },
  { key: 'all', label: '一年', hours: 24 * 366 },
];

// 各变体的识别色:实盘用单色主色,基准/现金用灰;4 个消融变体用克制的分类色
// (变体身份属"颜色编码数据"的正当用法,避免与盈亏绿/红撞色)。
function buildVariantColors(mode, CHART) {
  return {
    actual: mode === 'light' ? ACCENT_PRIMARY.light : ACCENT_PRIMARY.dark,
    no_risk_officer: '#7C6FF0', // 紫
    no_macro_filter: '#D4A843', // 琥珀
    immediate_trade: '#3FB7C4', // 青
    equal_weight: '#E0719B', // 玫红
    spy_benchmark: CHART.benchmark,
    cash: CHART.reference,
  };
}

const VARIANT_ORDER = [
  'actual',
  'no_risk_officer',
  'no_macro_filter',
  'immediate_trade',
  'equal_weight',
  'spy_benchmark',
  'cash',
];

const SHADOW_TRIGGER_LABELS = { ...TRIGGER_LABELS, benchmark: '基准建仓', news: '新闻信号' };

function pctClass(v) {
  return v > 0 ? 'up' : v < 0 ? 'down' : '';
}

const MIRROR_STATUS_LABELS = {
  submitted: '在途',
  partially_filled: '部分成交',
  filled: '已成交',
  canceled: '已撤销',
  expired: '已过期',
  rejected: '被拒绝',
  skipped: '跳过',
  error: '出错',
};

/**
 * 券商模拟对照账本:实盘每笔成交镜像到外部券商模拟账户(真实盘口撮合),
 * 逐笔成交价偏差(bps,正值=对我们不利)+ 账户净值对照 —— 校准内部滑点模型。
 * 未配置券商账户时整卡隐藏;version 变化(SSE/重置)时重拉。
 */
function BrokerMirrorCard({ version = 0 }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .brokerMirror()
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData(null));
    return () => {
      cancelled = true;
    };
  }, [version]);

  if (!data?.enabled) return null;
  if (!data.available) {
    return (
      <Card size="small" title="券商模拟对照账本">
        <Typography.Text type="secondary">
          已配置券商模拟账户,但对照数据表不可用(请执行 021 迁移)。
        </Typography.Text>
      </Card>
    );
  }

  const { account, stats, recent } = data;
  const bpsCell = (v) => {
    if (v === null || v === undefined) return '—';
    const n = Number(v);
    // 正值 = 券商撮合对我们不利(内部账本记赚了),按风险色红显
    return <span className={`num ${n > 0 ? 'down' : n < 0 ? 'up' : ''}`}>{n > 0 ? '+' : ''}{fmtNum(n, 1)}</span>;
  };
  const columns = [
    { title: '时间', dataIndex: 'submitted_at', width: 130, render: (v) => <span className="num">{fmtTime(v)}</span> },
    { title: '代码', dataIndex: 'symbol', width: 80 },
    { title: '方向', dataIndex: 'side', width: 60, render: (v) => (v === 'buy' ? <Tag color="green">买入</Tag> : <Tag color="red">卖出</Tag>) },
    { title: '内部价', dataIndex: 'internal_price', width: 90, align: 'right', render: (v) => <span className="num">{fmtMoney(v)}</span> },
    { title: '券商价', dataIndex: 'filled_avg_price', width: 90, align: 'right', render: (v) => (v ? <span className="num">{fmtMoney(v)}</span> : '—') },
    { title: '偏差(bps)', dataIndex: 'diff_bps', width: 90, align: 'right', render: bpsCell },
    { title: '状态', dataIndex: 'status', width: 90, render: (v, row) => <span title={row.note || ''}>{MIRROR_STATUS_LABELS[v] || v}</span> },
  ];

  return (
    <Card size="small" title="券商模拟对照账本(真实盘口撮合)">
      <Descriptions size="small" column={{ xs: 2, sm: 4 }} bordered>
        <Descriptions.Item label="券商账户净值">
          {account ? <span className="num">{fmtMoney(account.equity)}</span> : '—'}
        </Descriptions.Item>
        <Descriptions.Item label="净值偏离">
          {account?.diff_percent === null || account?.diff_percent === undefined ? (
            '—'
          ) : (
            // 偏离超过 ±0.5% 才标红提醒(方向本身不分好坏,大偏离才说明两本账在分叉)
            <span className={`num ${Math.abs(account.diff_percent) > 0.5 ? 'down' : ''}`}>
              {account.diff_percent > 0 ? '+' : ''}
              {fmtNum(account.diff_percent, 2)}%
            </span>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="对照单(成交/总数)">
          <span className="num">
            {stats.filled}/{stats.orders}
            {stats.fill_rate !== null && (
              <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
                ({fmtNum(stats.fill_rate, 1)}%)
              </Typography.Text>
            )}
          </span>
        </Descriptions.Item>
        <Descriptions.Item label="平均偏差">
          {stats.avg_bps === null ? '—' : <>{bpsCell(stats.avg_bps)}<Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>bps(买 {stats.buy.avg_bps ?? '—'} / 卖 {stats.sell.avg_bps ?? '—'})</Typography.Text></>}
        </Descriptions.Item>
      </Descriptions>

      {Boolean(recent?.length) && (
        <Table
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={recent}
          pagination={false}
          scroll={{ x: 640 }}
          style={{ marginTop: 12 }}
        />
      )}
      <Typography.Paragraph type="secondary" style={{ fontSize: 13, margin: '12px 0 0' }}>
        实盘每笔成交同步以「限价单」发往券商模拟账户,按真实盘口撮合(盘前盘后带盘外标记,当日有效)。
        偏差为正表示券商撮合价对我们不利(买得更贵/卖得更便宜)——即内部滑点模型偏乐观;
        长期未成交/过期的单说明该价格在真实盘口拿不到。净值偏离与逐笔偏差共同回答:
        内部账本的收益有多少经得起真实撮合的检验。
      </Typography.Paragraph>
    </Card>
  );
}

/**
 * 消融实验页:实盘与各影子变体的净值曲线(窗口起点归一为 0%)与汇总对比。
 * 影子组合从启用时刻开始与实盘并行记账,每套关闭一层防线——
 * 差值就是该层防线在这段行情里的净贡献。
 */
// version:App 在 SSE macro 事件/兜底轮询/重置后递增,触发重拉(否则重置后停留在旧数据)
export default function AblationPage({ version = 0, onSymbolClick }) {
  const { mode } = useThemeMode();
  const CHART = getChart(mode);
  const PNL = getPnl(mode);
  const VARIANT_COLORS = useMemo(() => buildVariantColors(mode, CHART), [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const [rangeKey, setRangeKey] = useState('1w');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  // 展开行的成交流水懒加载缓存:variant -> { loading, trades, error }
  const [tradeCache, setTradeCache] = useState({});

  const loadVariantTrades = useCallback((variant) => {
    setTradeCache((prev) => {
      if (prev[variant]) return prev; // 已加载/加载中,不重复请求
      const fetcher =
        variant === 'actual'
          ? api.trades(100).then((r) => r.trades || r || [])
          : api.shadowTrades(variant).then((r) => r.trades || []);
      fetcher
        .then((trades) =>
          setTradeCache((p) => ({ ...p, [variant]: { loading: false, trades } }))
        )
        .catch((err) =>
          setTradeCache((p) => ({ ...p, [variant]: { loading: false, trades: [], error: err.message } }))
        );
      return { ...prev, [variant]: { loading: true, trades: [] } };
    });
  }, []);

  const range = RANGES.find((r) => r.key === rangeKey);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.shadow(range.hours));
      setError(null);
      setTradeCache({}); // 重新拉取后清空展开缓存,避免展示过期成交
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }, [range.hours]);

  useEffect(() => {
    load();
  }, [load, version]);

  // 各序列重基:窗口内首点 = 0%,统一为相对收益曲线(各组合起始资金/时点不同,绝对值不可比)
  const chartSeries = useMemo(() => {
    if (!data?.available) return [];
    const all = { actual: data.actual?.series || [], ...(data.series || {}) };
    return VARIANT_ORDER.filter((v) => (all[v] || []).length > 1).map((variant) => {
      const rows = all[variant];
      const base = Number(rows[0].total_value);
      return {
        variant,
        name: SHADOW_VARIANT_LABELS[variant] || variant,
        color: VARIANT_COLORS[variant] || CHART.axis,
        rows: rows.map((p) => ({
          time: new Date(p.t).getTime(),
          pct: base > 0 ? ((Number(p.total_value) - base) / base) * 100 : 0,
        })),
      };
    });
  }, [data, VARIANT_COLORS]);

  const tableRows = useMemo(() => {
    if (!data?.available) return [];
    const rows = [];
    if (data.actual && data.actual.total_value !== null) {
      rows.push({
        variant: 'actual',
        total_value: data.actual.total_value,
        pnl_percent: data.actual.pnl_percent,
        cash: data.actual.cash,
        positions_count: data.actual.positions_count,
        trades_count: null,
        started_at: null,
        positions: null, // 实盘持仓明细见主页,这里不重复
        win_rate: null,
      });
    }
    const byVariant = new Map((data.variants || []).map((v) => [v.variant, v]));
    for (const key of VARIANT_ORDER) {
      const v = byVariant.get(key);
      if (!v) continue;
      rows.push({
        variant: v.variant,
        total_value: v.total_value,
        pnl_percent: v.pnl_percent,
        cash: v.cash,
        positions_count: v.positions?.length ?? 0,
        trades_count: v.trades_count,
        started_at: v.started_at,
        positions: v.positions || [],
        win_rate: v.win_rate ?? null,
        wins: v.wins ?? null,
        closed_trades: v.closed_trades ?? null,
      });
    }
    return rows;
  }, [data]);

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
        message="影子组合 / 消融实验尚未启用"
        description="数据库还没有影子组合相关表(017 迁移),执行迁移后系统会自动开始与实盘并行记账。"
      />
    );
  }
  if (!data) return <Empty description="暂无数据" />;

  const summaryColumns = [
    {
      title: '组合',
      dataIndex: 'variant',
      width: 150,
      render: (v) => (
        <Tag color={v === 'actual' ? 'blue' : 'default'} style={{ marginRight: 0 }}>
          {SHADOW_VARIANT_LABELS[v] || v}
        </Tag>
      ),
    },
    {
      title: '说明',
      dataIndex: 'variant',
      key: 'desc',
      ellipsis: true,
      render: (v) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {SHADOW_VARIANT_DESCRIPTIONS[v] || ''}
        </Typography.Text>
      ),
    },
    {
      title: '总资产',
      dataIndex: 'total_value',
      width: 120,
      align: 'right',
      render: (v) => <span className="num">{fmtMoney(v)}</span>,
    },
    {
      title: '自启用收益',
      dataIndex: 'pnl_percent',
      width: 110,
      align: 'right',
      render: (v) =>
        v === null || v === undefined ? '—' : <span className={`num ${pctClass(Number(v))}`}>{fmtPercent(v)}</span>,
    },
    {
      title: '现金',
      dataIndex: 'cash',
      width: 120,
      align: 'right',
      render: (v) => <span className="num">{fmtMoney(v)}</span>,
    },
    {
      title: '持仓',
      dataIndex: 'positions_count',
      width: 70,
      align: 'right',
      render: (v) => (v === null || v === undefined ? '—' : <span className="num">{v}</span>),
    },
    {
      title: '交易笔数',
      dataIndex: 'trades_count',
      width: 90,
      align: 'right',
      render: (v) => (v === null || v === undefined ? '—' : <span className="num">{v}</span>),
    },
  ];

  const tradeColumns = [
    { title: '时间', dataIndex: 'created_at', width: 110, render: (v) => fmtTime(v) },
    {
      title: '组合',
      dataIndex: 'variant',
      width: 120,
      render: (v) => SHADOW_VARIANT_LABELS[v] || v,
    },
    {
      title: '方向',
      dataIndex: 'side',
      width: 60,
      render: (v) => <span className={v === 'buy' ? 'up' : 'down'}>{v === 'buy' ? '买入' : '卖出'}</span>,
    },
    { title: '代码', dataIndex: 'symbol', width: 80 },
    {
      title: '数量',
      dataIndex: 'quantity',
      width: 90,
      align: 'right',
      render: (v) => <span className="num">{fmtNum(v, 4)}</span>,
    },
    {
      title: '价格',
      dataIndex: 'price',
      width: 90,
      align: 'right',
      render: (v) => <span className="num">{fmtMoney(v)}</span>,
    },
    {
      title: '盈亏',
      dataIndex: 'realized_pnl',
      width: 90,
      align: 'right',
      render: (v) =>
        v === null || v === undefined ? '—' : <span className={`num ${pctClass(Number(v))}`}>{fmtMoney(v)}</span>,
    },
    {
      title: '触发',
      dataIndex: 'trigger',
      width: 90,
      render: (v) => SHADOW_TRIGGER_LABELS[v] || v,
    },
    { title: '理由', dataIndex: 'reason', ellipsis: true },
  ];

  // 展开详情用:持仓列(代码可点击,复用主页持仓样式)
  const positionColumns = [
    {
      title: '代码',
      dataIndex: 'symbol',
      width: 90,
      render: (symbol) =>
        onSymbolClick ? (
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => onSymbolClick(symbol)}>
            {symbol}
          </Button>
        ) : (
          symbol
        ),
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      width: 90,
      align: 'right',
      render: (v) => <span className="num">{fmtNum(v, 4)}</span>,
    },
    {
      title: '平均成本',
      dataIndex: 'avg_cost',
      width: 100,
      align: 'right',
      render: (v) => <span className="num">{fmtMoney(v)}</span>,
    },
    {
      title: '现价',
      dataIndex: 'current_price',
      width: 100,
      align: 'right',
      render: (v) => <span className="num">{fmtMoney(v)}</span>,
    },
    {
      title: '市值',
      dataIndex: 'market_value',
      width: 110,
      align: 'right',
      render: (v) => <span className="num">{fmtMoney(v)}</span>,
    },
    {
      title: '浮动盈亏',
      dataIndex: 'unrealized_pnl_percent',
      width: 100,
      align: 'right',
      render: (v) => <span className={`num ${pctClass(Number(v))}`}>{fmtPercent(v)}</span>,
    },
  ];

  // 展开详情用:该变体成交列(去掉「组合」列,上下文已确定)
  const variantTradeColumns = tradeColumns.filter((c) => c.key !== 'desc' && c.dataIndex !== 'variant');

  const renderExpanded = (record) => {
    const cache = tradeCache[record.variant];
    return (
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
          {SHADOW_VARIANT_DESCRIPTIONS[record.variant] || ''}
        </Typography.Paragraph>

        <Descriptions size="small" column={{ xs: 2, sm: 3 }} bordered>
          <Descriptions.Item label="总资产">
            <span className="num">{fmtMoney(record.total_value)}</span>
          </Descriptions.Item>
          <Descriptions.Item label="自启用收益">
            {record.pnl_percent === null || record.pnl_percent === undefined ? (
              '—'
            ) : (
              <span className={`num ${pctClass(Number(record.pnl_percent))}`}>{fmtPercent(record.pnl_percent)}</span>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="现金">
            <span className="num">{fmtMoney(record.cash)}</span>
          </Descriptions.Item>
          <Descriptions.Item label="持仓数">
            <span className="num">{record.positions_count ?? '—'}</span>
          </Descriptions.Item>
          <Descriptions.Item label="交易笔数">
            <span className="num">{record.trades_count ?? '—'}</span>
          </Descriptions.Item>
          <Descriptions.Item label="交易胜率">
            {record.win_rate === null || record.win_rate === undefined ? (
              <Typography.Text type="secondary">暂无平仓</Typography.Text>
            ) : (
              <span className="num">
                {fmtNum(record.win_rate, 1)}%
                <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
                  ({record.wins}/{record.closed_trades})
                </Typography.Text>
              </span>
            )}
          </Descriptions.Item>
        </Descriptions>

        <div>
          <Typography.Text type="secondary" className="label-caps">
            持仓
          </Typography.Text>
          {record.positions === null ? (
            <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0', fontSize: 12.5 }}>
              实盘持仓明细见「实时仪表盘」。
            </Typography.Paragraph>
          ) : !record.positions.length ? (
            <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0', fontSize: 12.5 }}>
              当前无持仓。
            </Typography.Paragraph>
          ) : (
            <Table
              rowKey="symbol"
              size="small"
              columns={positionColumns}
              dataSource={record.positions}
              pagination={false}
              scroll={{ x: 600 }}
              style={{ marginTop: 6 }}
            />
          )}
        </div>

        <div>
          <Typography.Text type="secondary" className="label-caps">
            交易记录
          </Typography.Text>
          {!cache || cache.loading ? (
            <div style={{ textAlign: 'center', padding: 16 }}>
              <Spin size="small" />
            </div>
          ) : cache?.error ? (
            <Alert type="error" message={cache.error} style={{ marginTop: 6 }} />
          ) : !cache?.trades?.length ? (
            <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0', fontSize: 12.5 }}>
              暂无成交记录。
            </Typography.Paragraph>
          ) : (
            <Table
              rowKey="id"
              size="small"
              columns={variantTradeColumns}
              dataSource={cache.trades}
              pagination={{ pageSize: 10, hideOnSinglePage: true, size: 'small' }}
              scroll={{ x: 620 }}
              style={{ marginTop: 6 }}
            />
          )}
        </div>
      </Space>
    );
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title="净值对比(窗口起点归一为 0%)"
        extra={
          <Space>
            <Segmented
              size="small"
              options={RANGES.map((r) => ({ label: r.label, value: r.key }))}
              value={rangeKey}
              onChange={setRangeKey}
            />
            <Button size="small" onClick={load} loading={loading}>
              刷新
            </Button>
          </Space>
        }
      >
        {!chartSeries.length ? (
          <Typography.Text type="secondary">
            该时间范围内暂无足够的净值快照(影子组合每 10 分钟记一次净值,启用后会逐渐积累)。
          </Typography.Text>
        ) : (
          <ResponsiveContainer width="100%" height={360}>
            <LineChart margin={{ top: 10, right: 8, bottom: 0, left: 4 }}>
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
                allowDuplicatedCategory={false}
              />
              <YAxis
                tickFormatter={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`}
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
                formatter={(value, name) => [
                  <span key="v" style={{ color: value >= 0 ? PNL.up : PNL.down }}>
                    {fmtPercent(value)}
                  </span>,
                  name,
                ]}
              />
              <Legend />
              <ReferenceLine y={0} stroke={CHART.reference} strokeDasharray="4 4" />
              {chartSeries.map((s) => (
                <Line
                  key={s.variant}
                  data={s.rows}
                  name={s.name}
                  dataKey="pct"
                  type="monotone"
                  stroke={s.color}
                  strokeWidth={s.variant === 'actual' ? 2.5 : 1.5}
                  strokeDasharray={
                    s.variant === 'spy_benchmark' || s.variant === 'cash' ? '5 4' : undefined
                  }
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>

      <Card size="small" title="组合对比(点击行展开:说明 / 胜率 / 持仓 / 成交)">
        <Table
          rowKey="variant"
          size="small"
          columns={summaryColumns}
          dataSource={tableRows}
          pagination={false}
          scroll={{ x: 860 }}
          expandable={{
            expandedRowRender: renderExpanded,
            onExpand: (expanded, record) => {
              if (expanded) loadVariantTrades(record.variant);
            },
          }}
        />
        <Typography.Paragraph type="secondary" style={{ fontSize: 13, margin: '12px 0 0' }}>
          每套影子组合与实盘并行记账、各自从初始资金起步,只关闭一层防线:若「无风控官」长期跑输实盘,
          说明风控官的否决在创造价值;若「无宏观过滤」跑赢,说明宏观层可能过度拦截;「信号即时成交」
          对比实盘可衡量候选池 + LLM 决策链的净价值;「信号等权买入」对比实盘可检验 LLM 仓位分配是否有效。
          注意:影子组合没有走 LLM 的路径(宏观拦截重放/即时成交/等权)使用确定性仓位与默认止损止盈,
          是消融近似而非完整重放;结论应结合「信号质量」页的前瞻收益统计交叉验证,样本不足一个月时不要下结论。
        </Typography.Paragraph>
      </Card>

      <BrokerMirrorCard version={version} />

      {Boolean(data.recent_trades?.length) && (
        <Card size="small" title="最近影子成交">
          <Table
            rowKey="id"
            size="small"
            columns={tradeColumns}
            dataSource={data.recent_trades}
            pagination={false}
            scroll={{ x: 920 }}
          />
        </Card>
      )}
    </Space>
  );
}
