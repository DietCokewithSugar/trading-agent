import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Alert, App as AntApp, Badge, Segmented, Tabs, Tag, Tooltip, Typography } from 'antd';
import {
  AimOutlined,
  DashboardOutlined,
  ExperimentOutlined,
  FallOutlined,
  GlobalOutlined,
  HistoryOutlined,
  MoonOutlined,
  ReadOutlined,
  RiseOutlined,
  SunOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { api, fmtMoney, fmtNum, fmtPercent, SESSION_LABELS, REGIME_LABELS } from './api.js';
import { useThemeMode } from './theme-context.jsx';
import { QuotesProvider } from './quotes-context.jsx';
import Dashboard from './components/Dashboard.jsx';
import NewsFeed from './components/NewsFeed.jsx';
import TradesPage from './components/TradesPage.jsx';
import MacroPage from './components/MacroPage.jsx';
import SignalStatsPage from './components/SignalStatsPage.jsx';
import AblationPage from './components/AblationPage.jsx';
import BacktestPage from './components/BacktestPage.jsx';
import SymbolModal from './components/SymbolModal.jsx';
import AdminPage from './components/AdminPage.jsx';
import StrategyPage from './components/StrategyPage.jsx';

const TABS = [
  { key: 'dashboard', label: '仪表盘', icon: <DashboardOutlined /> },
  { key: 'news', label: '新闻分析', icon: <ReadOutlined /> },
  { key: 'trades', label: '交易记录', icon: <SwapOutlined /> },
  { key: 'macro', label: '宏观', icon: <GlobalOutlined /> },
  { key: 'signals', label: '信号质量', icon: <AimOutlined /> },
  { key: 'ablation', label: '消融实验', icon: <ExperimentOutlined /> },
  { key: 'backtest', label: '策略回测', icon: <HistoryOutlined /> },
];

// 深浅主题切换控件(图标,无 emoji)
function ThemeToggle() {
  const { mode, setMode } = useThemeMode();
  return (
    <Segmented
      size="small"
      value={mode}
      onChange={setMode}
      options={[
        { value: 'dark', icon: <MoonOutlined />, title: '深色' },
        { value: 'light', icon: <SunOutlined />, title: '浅色' },
      ]}
    />
  );
}

// SSE 断线时的兜底轮询间隔
const FALLBACK_REFRESH_MS = 60_000;
// 快照折线图在前端最多保留的点数(服务端采样上限同为 600),防止长期挂机内存膨胀
const MAX_SNAPSHOT_POINTS = 600;

function MainApp() {
  const { notification } = AntApp.useApp();
  const [tab, setTab] = useState('dashboard');
  const [portfolio, setPortfolio] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [trades, setTrades] = useState([]);
  // 新闻数据由新闻页自行按筛选条件拉取,这里只广播"有新内容"的版本号
  const [newsVersion, setNewsVersion] = useState(0);
  // 宏观页同理:SSE macro 事件只递增版本号,页面自行拉取
  const [macroVersion, setMacroVersion] = useState(0);
  // 回测页:SSE backtest 事件携带进度,直接透传给页面(版本号 + 最近一次进度载荷)
  const [backtestEvent, setBacktestEvent] = useState(null);
  const [stats, setStats] = useState(null);
  const [performance, setPerformance] = useState(null);
  const [error, setError] = useState(null);
  const [live, setLive] = useState(false);
  const liveRef = useRef(false);
  const [activeSymbol, setActiveSymbol] = useState(null);
  // 实时报价映射(SSE quotes 事件,大写 symbol → 报价):候选池/个股弹窗经 QuotesProvider 消费
  const [liveQuotes, setLiveQuotes] = useState({});

  const pushToast = useCallback(
    (text, tone = '') => {
      notification.open({
        message: <span className={tone}>{text}</span>,
        placement: 'bottomRight',
        duration: 5,
      });
    },
    [notification]
  );

  const refresh = useCallback(async () => {
    try {
      const [p, s, t, stt, perf] = await Promise.all([
        api.portfolio(),
        api.snapshots(),
        api.trades(),
        api.stats(),
        api.performance().catch(() => null),
      ]);
      setPortfolio(p);
      setSnapshots(s);
      setTrades(t);
      setNewsVersion((v) => v + 1);
      // 宏观页/候选池/消融页自行拉取数据,这里同样递增版本号:
      // SSE 断线的兜底轮询期间与重置/重连补拉时,这些页面不能停在旧数据
      setMacroVersion((v) => v + 1);
      setStats(stt);
      if (perf) setPerformance(perf);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  // 兜底轮询只在 SSE 断线时工作:实时连接正常时所有数据都由推送驱动,无需整页重拉
  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (!liveRef.current) refresh();
    }, FALLBACK_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // SSE 实时推送:报价/快照直接带数据,其余事件触发对应数据的增量拉取
  useEffect(() => {
    const es = new EventSource('/api/stream');
    let wasDown = false;
    es.onopen = () => {
      liveRef.current = true;
      setLive(true);
      // 断线重连成功后整体补一次,追平断线期间漏掉的推送
      if (wasDown) {
        wasDown = false;
        refresh();
      }
    };
    es.onerror = () => {
      liveRef.current = false;
      wasDown = true;
      setLive(false);
      // 断线即作废实时报价:否则冻结的旧 live 价会一直压过兜底轮询拉到的新价,
      // 还会抑制个股弹窗自己的兜底轮询(它以"live 覆盖该票"为不轮询条件)
      setLiveQuotes({});
    };

    es.addEventListener('portfolio', (e) => setPortfolio(JSON.parse(e.data)));
    // 实时报价映射(持仓 + 候选池 top 符号):整包覆盖,消费方自行按 symbol 取用
    es.addEventListener('quotes', (e) => {
      try {
        setLiveQuotes(JSON.parse(e.data).quotes || {});
      } catch { /* 忽略畸形数据 */ }
    });
    es.addEventListener('snapshot', (e) => {
      const snap = JSON.parse(e.data);
      setSnapshots((prev) => [...prev.slice(-(MAX_SNAPSHOT_POINTS - 1)), snap]);
    });
    es.addEventListener('news', () => setNewsVersion((v) => v + 1));
    es.addEventListener('analysis', (e) => {
      setNewsVersion((v) => v + 1);
      try {
        const a = JSON.parse(e.data);
        if (a.tier && a.tier <= 2) {
          pushToast(
            `${a.sentiment === 'bullish' ? '利好' : '利空'}信号 ${a.symbol} · 第${a.tier}档`,
            a.sentiment === 'bullish' ? 'up' : 'down'
          );
        }
      } catch { /* 忽略畸形数据 */ }
    });
    es.addEventListener('trade', (e) => {
      api.trades().then(setTrades).catch(() => {});
      api.portfolio().then(setPortfolio).catch(() => {});
      api.stats().then(setStats).catch(() => {});
      api.performance().then(setPerformance).catch(() => {});
      try {
        const t = JSON.parse(e.data);
        const verb = t.side === 'buy' ? '买入' : '卖出';
        const prefix =
          t.trigger === 'stop_loss'
            ? '止损'
            : t.trigger === 'take_profit'
              ? '止盈'
              : t.trigger === 'review'
                ? '复查'
                : '';
        pushToast(
          `${prefix}${verb} ${t.symbol} ${fmtNum(t.quantity, 4)} 股 @ ${fmtMoney(t.price)}`,
          t.side === 'buy' ? 'up' : 'down'
        );
      } catch { /* 忽略畸形数据 */ }
    });
    // 宏观环境切换 / 候选池变化:递增版本号触发宏观页重拉,regime 切换时弹提示
    es.addEventListener('macro', (e) => {
      setMacroVersion((v) => v + 1);
      try {
        const m = JSON.parse(e.data);
        if (m.regime && REGIME_LABELS[m.regime]) {
          pushToast(`宏观环境切换:${REGIME_LABELS[m.regime]}`, m.regime === 'risk_on' ? 'up' : m.regime === 'neutral' ? '' : 'down');
        }
      } catch { /* 忽略畸形数据 */ }
    });
    // 回测进度/完成:载荷直接给回测页(进度条实时化;完成/失败触发列表重拉)
    es.addEventListener('backtest', (e) => {
      try {
        setBacktestEvent(JSON.parse(e.data));
      } catch { /* 忽略畸形数据 */ }
    });
    // 管理后台切换了展示主账本:净值/指标/交易记录整体换源,一次全量刷新原子切换
    // (否则 stats/trades 要等下一次成交事件才换,且净值图会新旧账本点混线)
    es.addEventListener('ledger', () => refresh());
    // 管理后台执行了全量数据重置:全部数据作废,整体刷新,清空实时报价残留
    es.addEventListener('reset', () => {
      setLiveQuotes({});
      refresh();
      pushToast('数据已重置,账户恢复初始状态');
    });

    return () => es.close();
  }, [pushToast, refresh]);

  const pnl = portfolio?.pnl ?? 0;
  const session = portfolio?.market_session;
  const dayPnl = stats?.day_pnl;

  // 次要指标(账户条右侧):现金 / 持仓 / 盈亏
  const heroMetrics = portfolio
    ? [
        { label: '可用现金', value: <span className="num">{fmtMoney(portfolio.cash)}</span> },
        { label: '持仓市值', value: <span className="num">{fmtMoney(portfolio.positions_value)}</span> },
        {
          label: '总盈亏',
          value: (
            <span className={`num ${pnl >= 0 ? 'up' : 'down'}`}>
              {fmtMoney(pnl)} ({fmtPercent(portfolio.pnl_percent)})
            </span>
          ),
        },
      ]
    : [];

  return (
    <QuotesProvider value={liveQuotes}>
    <div className="app">
      <header>
        <div className="header-top">
          <h1>AI 新闻交易员</h1>
          <div className="header-actions">
            <Typography.Link href="#/strategy" style={{ fontSize: 13 }}>
              投资策略说明
            </Typography.Link>
            {session && (
              <Tag bordered style={{ marginRight: 0 }} className="label-caps">
                {SESSION_LABELS[session]}
              </Tag>
            )}
            <Badge
              status={live ? 'processing' : 'default'}
              text={live ? '实时' : '轮询'}
              title={live ? '已建立 SSE 实时连接' : '实时连接断开,使用兜底轮询'}
            />
            <ThemeToggle />
          </div>
        </div>
        {portfolio && (
          <div className="hero">
            <div className="hero__primary">
              <div
                className="label-caps"
                style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}
              >
                总资产
                {/* 主账本切到券商时的克制提示:数字来自券商真实撮合的模拟账户 */}
                {portfolio.ledger === 'broker' && (
                  <Tooltip title="账户数据由券商模拟账户实时驱动(真实撮合);内部模拟账本继续在后台运行,可在管理页切回">
                    <Tag bordered className="label-caps" style={{ marginRight: 0 }}>
                      券商模拟账本
                    </Tag>
                  </Tooltip>
                )}
              </div>
              <div className="display-num">{fmtMoney(portfolio.total_value)}</div>
              {dayPnl !== null && dayPnl !== undefined && (
                <div style={{ marginTop: 8 }}>
                  <span className={`delta-chip num ${dayPnl >= 0 ? 'up' : 'down'}`}>
                    {dayPnl >= 0 ? <RiseOutlined /> : <FallOutlined />}
                    {fmtMoney(dayPnl)}
                    {stats?.day_pnl_percent !== null && stats?.day_pnl_percent !== undefined
                      ? ` (${fmtPercent(stats.day_pnl_percent)})`
                      : ''}
                  </span>
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12.5 }}>今日</span>
                </div>
              )}
            </div>
            <div className="hero__secondary">
              {heroMetrics.map((m) => (
                <div className="hero__metric" key={m.label}>
                  <span className="label-caps">{m.label}</span>
                  <span style={{ fontSize: 16 }}>{m.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {error && <Alert type="error" banner message={error} style={{ marginTop: 12 }} />}
      </header>

      <Tabs activeKey={tab} onChange={setTab} items={TABS} style={{ marginTop: 8 }} />

      <main>
        {tab === 'dashboard' && (
          <Dashboard
            portfolio={portfolio}
            snapshots={snapshots}
            trades={trades}
            stats={stats}
            performance={performance}
            onSymbolClick={setActiveSymbol}
            onNavigate={setTab}
          />
        )}
        {tab === 'news' && <NewsFeed version={newsVersion} onSymbolClick={setActiveSymbol} />}
        {tab === 'trades' && (
          <TradesPage trades={trades} macroVersion={macroVersion} onSymbolClick={setActiveSymbol} />
        )}
        {tab === 'macro' && <MacroPage version={macroVersion} />}
        {tab === 'signals' && <SignalStatsPage />}
        {tab === 'ablation' && <AblationPage version={macroVersion} onSymbolClick={setActiveSymbol} />}
        {tab === 'backtest' && <BacktestPage event={backtestEvent} onSymbolClick={setActiveSymbol} />}
      </main>

      <footer className="footer">模拟交易,不构成投资建议</footer>

      <SymbolModal
        symbol={activeSymbol}
        open={Boolean(activeSymbol)}
        onClose={() => setActiveSymbol(null)}
      />
    </div>
    </QuotesProvider>
  );
}

/** 根组件:#/admin 进入隐藏管理页,#/strategy 进入投资策略说明页,其余渲染主面板 */
export default function App() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (hash === '#/admin') return <AdminPage />;
  if (hash === '#/strategy') return <StrategyPage />;
  return <MainApp />;
}
