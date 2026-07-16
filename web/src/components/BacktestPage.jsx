import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  DatePicker,
  Empty,
  Input,
  InputNumber,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import {
  api,
  fmtMoney,
  fmtNum,
  fmtPercent,
  fmtTime,
  BACKTEST_STRATEGY_LABELS,
  BACKTEST_STATUS_LABELS,
  BACKTEST_DROP_LABELS,
  TRIGGER_LABELS,
} from '../api.js';
import { useThemeMode } from '../theme-context.jsx';
import { getChart, ACCENT_PRIMARY } from '../theme.js';
import ComparisonChart from './ComparisonChart.jsx';

const { Text } = Typography;

/** 策略曲线配色:AI 主线用品牌色(沿 AblationPage 的 actual 先例),其余避开盈亏红绿 */
function buildStrategyColors(mode, CHART) {
  return {
    ai: mode === 'light' ? ACCENT_PRIMARY.light : ACCENT_PRIMARY.dark,
    buy_hold: CHART.benchmark,
    macd: '#7C6FF0', // 紫
    kdj_rsi: '#D4A843', // 琥珀
    zmr: '#6B9AC4', // 钢蓝
    sma: '#3FB7C4', // 青
  };
}

const STRATEGY_ORDER = ['ai', 'buy_hold', 'macd', 'kdj_rsi', 'zmr', 'sma'];
const PHASE_LABELS = {
  bars: '拉取历史日线',
  news: '抓取历史新闻',
  analyze: '模型重析文章',
  simulate: '模拟撮合',
  done: '完成',
  failed: '失败',
};
const RUNNING_POLL_MS = 5000;

const statusTag = (status) => (
  <Tag
    bordered
    color={status === 'completed' ? 'success' : status === 'failed' ? 'warning' : status === 'running' ? 'processing' : 'default'}
  >
    {BACKTEST_STATUS_LABELS[status] || status}
  </Tag>
);

const pctCell = (v) =>
  v === null || v === undefined ? (
    <span className="muted">—</span>
  ) : (
    <span className={`num ${v >= 0 ? 'up' : 'down'}`}>{fmtPercent(v)}</span>
  );

export default function BacktestPage({ event, onSymbolClick }) {
  const { notification } = AntApp.useApp();
  const { mode } = useThemeMode();
  const CHART = getChart(mode);
  const COLORS = useMemo(() => buildStrategyColors(mode, CHART), [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const [overview, setOverview] = useState(null); // { available, running, runs }
  const [selectedId, setSelectedId] = useState(null);
  const [run, setRun] = useState(null); // 选中 run 的全量行
  const [submitting, setSubmitting] = useState(false);

  // 触发表单
  const [symbols, setSymbols] = useState(['AAPL', 'GOOGL', 'AMZN']);
  const [range, setRange] = useState([dayjs().subtract(3, 'month'), dayjs().subtract(1, 'day')]);
  const [costBps, setCostBps] = useState(0);
  const [token, setToken] = useState(() => {
    try {
      return sessionStorage.getItem('admin_token') || '';
    } catch {
      return '';
    }
  });

  const reqSeq = useRef(0);
  const loadRuns = useCallback(async () => {
    const seq = ++reqSeq.current;
    try {
      const data = await api.backtestRuns();
      if (seq === reqSeq.current) setOverview(data);
      return data;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  // 默认选中最新一轮
  useEffect(() => {
    if (!selectedId && overview?.runs?.length) setSelectedId(overview.runs[0].id);
  }, [overview, selectedId]);

  // 选中变化 → 拉全量结果
  const detailSeq = useRef(0);
  const loadRun = useCallback(async (id) => {
    if (!id) return;
    const seq = ++detailSeq.current;
    try {
      const data = await api.backtestRun(id);
      if (seq === detailSeq.current) setRun(data);
    } catch {
      /* 列表兜底轮询会重试 */
    }
  }, []);
  useEffect(() => {
    setRun(null);
    loadRun(selectedId);
  }, [selectedId, loadRun]);

  // SSE 事件:进度直接合入选中 run;终态重拉列表与详情
  useEffect(() => {
    if (!event) return;
    if (event.status === 'completed' || event.status === 'failed') {
      loadRuns();
      if (event.run_id === selectedId) loadRun(selectedId);
      else setSelectedId(event.run_id);
    } else if (event.status === 'running') {
      setOverview((prev) => {
        if (!prev) return prev;
        const runs = prev.runs.map((r) =>
          r.id === event.run_id
            ? { ...r, progress: { phase: event.phase, symbol: event.symbol, analyzed: event.analyzed, total: event.total } }
            : r
        );
        return { ...prev, running: true, runs };
      });
    }
  }, [event]); // eslint-disable-line react-hooks/exhaustive-deps

  // SSE 断线兜底:有 running 轮次时 5s 轮询列表
  const hasRunning = Boolean(overview?.running || overview?.runs?.some((r) => r.status === 'running'));
  useEffect(() => {
    if (!hasRunning) return undefined;
    const timer = setInterval(async () => {
      const data = await loadRuns();
      const stillRunning = data?.runs?.some((r) => r.status === 'running');
      if (!stillRunning && selectedId) loadRun(selectedId);
    }, RUNNING_POLL_MS);
    return () => clearInterval(timer);
  }, [hasRunning, loadRuns, loadRun, selectedId]);

  const submit = async () => {
    if (!symbols.length) {
      notification.warning({ message: '请至少输入一个标的代码' });
      return;
    }
    if (!range?.[0] || !range?.[1]) {
      notification.warning({ message: '请选择回测时间窗口' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.startBacktest(
        {
          symbols,
          from: range[0].format('YYYY-MM-DD'),
          to: range[1].format('YYYY-MM-DD'),
          cost_bps: costBps ?? 0,
        },
        token.trim()
      );
      notification.success({ message: '回测已发起', description: '进度将实时显示在运行历史中' });
      setSelectedId(res.run_id);
      loadRuns();
    } catch (err) {
      notification.error({ message: '发起失败', description: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const runsColumns = [
    {
      title: '发起时间',
      dataIndex: 'created_at',
      width: 130,
      render: (v) => <span className="num">{fmtTime(v)}</span>,
    },
    {
      title: '标的',
      dataIndex: 'params',
      render: (p) => (
        <Space size={4} wrap>
          {(p?.symbols || []).map((s) => (
            <Tag key={s} bordered className="num" style={{ marginRight: 0 }}>
              {s}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '窗口',
      dataIndex: 'params',
      width: 190,
      render: (p) => (
        <span className="num muted">
          {p?.from} ~ {p?.to}
        </span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 200,
      render: (status, row) => {
        if (status === 'running') {
          const pr = row.progress || {};
          const percent =
            pr.phase === 'analyze' && pr.total > 0
              ? Math.round(((pr.analyzed || 0) / pr.total) * 100)
              : pr.phase === 'simulate' || pr.phase === 'done'
                ? 99
                : 5;
          return (
            <Space size={8}>
              {statusTag(status)}
              <Progress percent={percent} size="small" style={{ width: 90, margin: 0 }} />
              <span className="muted" style={{ fontSize: 12 }}>
                {PHASE_LABELS[pr.phase] || pr.phase}
              </span>
            </Space>
          );
        }
        if (status === 'failed') {
          return (
            <Tooltip title={row.error}>
              <span>{statusTag(status)}</span>
            </Tooltip>
          );
        }
        return statusTag(status);
      },
    },
    {
      title: '模型调用',
      dataIndex: 'llm_calls',
      width: 110,
      align: 'right',
      render: (v, row) => (
        <span className="num muted">
          {fmtNum(v, 0)}
          {row.llm_cost_usd ? ` / $${fmtNum(row.llm_cost_usd, 3)}` : ''}
        </span>
      ),
    },
  ];

  const resultSymbols = run?.status === 'completed' ? Object.entries(run.result?.symbols || {}) : [];
  const initialValue = run?.result?.initial_value || run?.params?.initial_value || 10000;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {overview && !overview.available && (
        <Alert
          type="warning"
          showIcon
          message="回测功能不可用"
          description="数据库未配置或尚未执行 032 迁移(backtest_runs / backtest_analyses)。"
        />
      )}

      <Card title="发起回测" size="small">
        <Space size={12} wrap align="end">
          <div>
            <div className="label-caps" style={{ marginBottom: 4 }}>标的(最多 5 个)</div>
            <Select
              mode="tags"
              style={{ minWidth: 260 }}
              placeholder="输入代码后回车,如 AAPL"
              value={symbols}
              onChange={(vals) =>
                setSymbols(
                  [...new Set(vals.map((v) => String(v).trim().toUpperCase()).filter(Boolean))].slice(0, 5)
                )
              }
              tokenSeparators={[',', ' ']}
              open={false}
            />
          </div>
          <div>
            <div className="label-caps" style={{ marginBottom: 4 }}>时间窗口(美东日)</div>
            <DatePicker.RangePicker
              value={range}
              onChange={setRange}
              disabledDate={(d) => d && d.isAfter(dayjs().endOf('day'))}
              allowClear={false}
            />
          </div>
          <div>
            <div className="label-caps" style={{ marginBottom: 4 }}>成本(基点)</div>
            <InputNumber min={0} max={100} value={costBps} onChange={setCostBps} style={{ width: 100 }} />
          </div>
          <div>
            <div className="label-caps" style={{ marginBottom: 4 }}>管理令牌</div>
            <Tooltip title="服务端配置了 ADMIN_TOKEN 时必填;未配置可留空(匿名触发共享 30 分钟全局冷却)">
              <Input.Password
                style={{ width: 180 }}
                placeholder="未配置可留空"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </Tooltip>
          </div>
          <Button type="primary" onClick={submit} loading={submitting} disabled={overview ? !overview.available : false}>
            发起回测
          </Button>
        </Space>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
          回测会抓取窗口内的历史新闻并逐篇由模型重新分析(已分析过的文章命中缓存,不重复计费),
          再与经典基线策略(买入持有 / MACD / KDJ+RSI / 零均值回归 / SMA 双均线)同窗对比。
          窗口越长、标的越热门,文章越多、耗时越久。
        </div>
      </Card>

      <Card title="运行历史" size="small">
        <Table
          rowKey="id"
          size="small"
          columns={runsColumns}
          dataSource={overview?.runs || []}
          pagination={false}
          onRow={(row) => ({ onClick: () => setSelectedId(row.id), style: { cursor: 'pointer' } })}
          rowClassName={(row) => (row.id === selectedId ? 'ant-table-row-selected' : '')}
          locale={{ emptyText: <Empty description="暂无回测记录" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          scroll={{ x: 760 }}
        />
      </Card>

      {run?.status === 'failed' && (
        <Alert type="warning" showIcon message="该轮回测失败" description={run.error} />
      )}

      {resultSymbols.map(([symbol, data]) => (
        <SymbolResult
          key={`${run.id}:${symbol}`}
          symbol={symbol}
          data={data}
          colors={COLORS}
          initialValue={initialValue}
          onSymbolClick={onSymbolClick}
        />
      ))}

      {run?.status === 'completed' && (
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
          口径说明:AI 曲线为模型对窗口内历史新闻的重新分析(非当时实盘决策);跨源确认与事件链未回放,
          信号按「同一交易日同方向」归并、同日多空冲突双双搁置;所有策略均为单标的独立账本、多头全进全出,
          成交按日线收盘价(AI 策略的止损/止盈按当日高低价近似,跳空按开盘价),默认零交易成本;
          日线为拆股调整、未含股息。历史回测结果不预示未来表现,不构成投资建议。
        </div>
      )}
    </Space>
  );
}

function SymbolResult({ symbol, data, colors, initialValue, onSymbolClick }) {
  if (data.error) {
    return (
      <Card size="small" title={<span className="num">{symbol}</span>}>
        <Alert type="warning" showIcon message={data.error} />
      </Card>
    );
  }
  const strategies = data.strategies || {};
  const series = STRATEGY_ORDER.filter((k) => strategies[k]).map((key) => ({
    variant: key,
    name: BACKTEST_STRATEGY_LABELS[key] || key,
    color: colors[key],
    dashed: key === 'buy_hold',
    emphasis: key === 'ai',
    rows: (strategies[key].equity || []).map((p) => ({
      time: Date.parse(`${p.date}T16:00:00-05:00`),
      pct: p.pct,
    })),
  }));

  const metricRows = STRATEGY_ORDER.filter((k) => strategies[k]).map((key) => ({
    key,
    name: BACKTEST_STRATEGY_LABELS[key] || key,
    ...strategies[key].metrics,
    trades: strategies[key].trades || [],
    trades_truncated: strategies[key].trades_truncated,
  }));

  const dropped = Object.entries(data.signals?.dropped || {}).filter(([, n]) => n > 0);

  const metricColumns = [
    {
      title: '策略',
      dataIndex: 'name',
      width: 130,
      render: (v, row) => (
        <span style={{ color: colors[row.key], fontWeight: row.key === 'ai' ? 600 : 400 }}>{v}</span>
      ),
    },
    { title: '累计收益', dataIndex: 'cr_percent', align: 'right', render: pctCell },
    { title: '年化', dataIndex: 'arr_percent', align: 'right', render: pctCell },
    {
      title: '夏普',
      dataIndex: 'sharpe',
      align: 'right',
      render: (v) => <span className="num">{v === null || v === undefined ? '—' : fmtNum(v, 2)}</span>,
    },
    {
      title: '最大回撤',
      dataIndex: 'max_drawdown_percent',
      align: 'right',
      render: (v) => <span className="num">{v === null || v === undefined ? '—' : `${fmtNum(v, 2)}%`}</span>,
    },
    {
      title: '交易次数',
      dataIndex: 'trade_count',
      align: 'right',
      render: (v) => <span className="num">{fmtNum(v, 0)}</span>,
    },
    {
      title: '胜率',
      align: 'right',
      render: (_, row) =>
        row.win_rate === null || row.win_rate === undefined ? (
          <span className="muted">—</span>
        ) : (
          <Tooltip title={row.win_rate_ci ? `Wilson 95% CI: ${row.win_rate_ci.lo}% ~ ${row.win_rate_ci.hi}%` : ''}>
            <span className="num">{fmtNum(row.win_rate, 1)}%</span>
          </Tooltip>
        ),
    },
  ];

  const tradeColumns = [
    { title: '日期', dataIndex: 'date', width: 110, render: (v) => <span className="num">{v}</span> },
    {
      title: '方向',
      dataIndex: 'side',
      width: 70,
      render: (v) => <span className={v === 'buy' ? 'up' : 'down'}>{v === 'buy' ? '买入' : '卖出'}</span>,
    },
    { title: '价格', dataIndex: 'price', align: 'right', render: (v) => <span className="num">{fmtNum(v, 4)}</span> },
    { title: '金额', dataIndex: 'amount', align: 'right', render: (v) => <span className="num">{fmtMoney(v)}</span> },
    {
      title: '触发',
      dataIndex: 'trigger',
      width: 90,
      render: (v) => <span className="muted">{TRIGGER_LABELS[v] || (v === 'signal' ? '信号' : v)}</span>,
    },
    {
      title: '已实现盈亏',
      dataIndex: 'realized_pnl',
      align: 'right',
      render: (v) =>
        v === null || v === undefined ? (
          <span className="muted">—</span>
        ) : (
          <span className={`num ${v >= 0 ? 'up' : 'down'}`}>{fmtMoney(v)}</span>
        ),
    },
  ];

  return (
    <Card
      size="small"
      title={
        <Space size={10}>
          <Typography.Link className="num" onClick={() => onSymbolClick?.(symbol)}>
            {symbol}
          </Typography.Link>
          <span className="muted" style={{ fontSize: 12.5, fontWeight: 400 }}>
            {data.first_date} ~ {data.last_date} · {fmtNum(data.bars_count, 0)} 个交易日 ·{' '}
            {fmtNum(data.articles, 0)} 篇新闻 · {fmtNum(data.signals?.count || 0, 0)} 条 AI 信号 ·
            初始 {fmtMoney(initialValue, 0)}
          </span>
        </Space>
      }
    >
      <ComparisonChart series={series} height={300} />
      <Table
        rowKey="key"
        size="small"
        style={{ marginTop: 12 }}
        columns={metricColumns}
        dataSource={metricRows}
        pagination={false}
        scroll={{ x: 720 }}
        expandable={{
          rowExpandable: (row) => row.trades.length > 0,
          expandedRowRender: (row) => (
            <div style={{ padding: '4px 0' }}>
              {row.trades_truncated && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  成交明细仅展示前 500 条
                </Text>
              )}
              <Table
                rowKey={(t, i) => `${t.date}:${t.side}:${i}`}
                size="small"
                columns={tradeColumns}
                dataSource={row.trades}
                pagination={row.trades.length > 20 ? { pageSize: 20, size: 'small' } : false}
                scroll={{ x: 640 }}
              />
            </div>
          ),
        }}
      />
      {dropped.length > 0 && (
        <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
          信号漏斗(被丢弃的分析结果):
          {dropped.map(([k, n]) => (
            <Tag key={k} bordered style={{ marginLeft: 6 }}>
              {BACKTEST_DROP_LABELS[k] || k} {n}
            </Tag>
          ))}
        </div>
      )}
    </Card>
  );
}
