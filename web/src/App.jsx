import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Alert, App as AntApp, Badge, Card, Col, Row, Statistic, Tabs, Tag, Typography } from 'antd';
import { api, fmtMoney, fmtNum, fmtPercent, SESSION_LABELS, REGIME_LABELS } from './api.js';
import Dashboard from './components/Dashboard.jsx';
import NewsFeed from './components/NewsFeed.jsx';
import TradesPage from './components/TradesPage.jsx';
import MacroPage from './components/MacroPage.jsx';
import SignalStatsPage from './components/SignalStatsPage.jsx';
import AblationPage from './components/AblationPage.jsx';
import SymbolModal from './components/SymbolModal.jsx';
import AdminPage from './components/AdminPage.jsx';
import StrategyPage from './components/StrategyPage.jsx';

const TABS = [
  { key: 'dashboard', label: '仪表盘' },
  { key: 'news', label: '新闻分析' },
  { key: 'trades', label: '交易记录' },
  { key: 'macro', label: '宏观' },
  { key: 'signals', label: '信号质量' },
  { key: 'ablation', label: '消融实验' },
];

const SESSION_TAG_COLORS = { pre: 'orange', regular: 'blue', post: 'orange', closed: 'default' };

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
  const [stats, setStats] = useState(null);
  const [performance, setPerformance] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [live, setLive] = useState(false);
  const liveRef = useRef(false);
  const [activeSymbol, setActiveSymbol] = useState(null);

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
      const [p, s, t, st, stt, perf] = await Promise.all([
        api.portfolio(),
        api.snapshots(),
        api.trades(),
        api.status(),
        api.stats(),
        api.performance().catch(() => null),
      ]);
      setPortfolio(p);
      setSnapshots(s);
      setTrades(t);
      setNewsVersion((v) => v + 1);
      setStatus(st);
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
    };

    es.addEventListener('portfolio', (e) => setPortfolio(JSON.parse(e.data)));
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
    es.addEventListener('cycle', () => api.status().then(setStatus).catch(() => {}));
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
    // 管理后台执行了全量数据重置:全部数据作废,整体刷新
    es.addEventListener('reset', () => {
      refresh();
      pushToast('数据已重置,账户恢复初始状态');
    });

    return () => es.close();
  }, [pushToast, refresh]);

  const pnl = portfolio?.pnl ?? 0;
  const session = portfolio?.market_session;

  const headerStats = portfolio
    ? [
        { title: '总资产', render: <span className="num">{fmtMoney(portfolio.total_value)}</span> },
        { title: '可用现金', render: <span className="num">{fmtMoney(portfolio.cash)}</span> },
        {
          title: '持仓市值',
          render: <span className="num">{fmtMoney(portfolio.positions_value)}</span>,
        },
        {
          title: '总盈亏',
          render: (
            <span className={`num ${pnl >= 0 ? 'up' : 'down'}`}>
              {fmtMoney(pnl)} ({fmtPercent(portfolio.pnl_percent)})
            </span>
          ),
        },
      ]
    : [];

  return (
    <div className="app">
      <header>
        <div className="header-top">
          <h1>AI 新闻交易员</h1>
          <div className="header-actions">
            <Typography.Link href="#/strategy" style={{ fontSize: 13 }}>
              投资策略说明
            </Typography.Link>
            {session && (
              <Tag color={SESSION_TAG_COLORS[session] || 'default'} style={{ marginRight: 0 }}>
                {SESSION_LABELS[session]}
              </Tag>
            )}
            <Badge
              status={live ? 'processing' : 'default'}
              text={live ? '实时' : '轮询'}
              title={live ? '已建立 SSE 实时连接' : '实时连接断开,使用兜底轮询'}
            />
          </div>
        </div>
        {portfolio && (
          <Row gutter={[12, 12]}>
            {headerStats.map((s) => (
              <Col xs={12} md={6} key={s.title}>
                <Card size="small">
                  <Statistic title={s.title} valueRender={() => s.render} />
                </Card>
              </Col>
            ))}
          </Row>
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
            status={status}
            onSymbolClick={setActiveSymbol}
          />
        )}
        {tab === 'news' && <NewsFeed version={newsVersion} onSymbolClick={setActiveSymbol} />}
        {tab === 'trades' && (
          <TradesPage trades={trades} macroVersion={macroVersion} onSymbolClick={setActiveSymbol} />
        )}
        {tab === 'macro' && <MacroPage version={macroVersion} />}
        {tab === 'signals' && <SignalStatsPage />}
        {tab === 'ablation' && <AblationPage />}
      </main>

      <footer className="footer">模拟交易,不构成投资建议</footer>

      <SymbolModal
        symbol={activeSymbol}
        open={Boolean(activeSymbol)}
        onClose={() => setActiveSymbol(null)}
      />
    </div>
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
