import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, fmtMoney, fmtNum, fmtPercent, SESSION_LABELS } from './api.js';
import Dashboard from './components/Dashboard.jsx';
import NewsFeed from './components/NewsFeed.jsx';
import TradesPage from './components/TradesPage.jsx';
import Toasts from './components/Toasts.jsx';
import SymbolModal from './components/SymbolModal.jsx';

const TABS = [
  { key: 'dashboard', label: '仪表盘' },
  { key: 'news', label: '新闻分析' },
  { key: 'trades', label: '交易记录' },
];

// SSE 断线时的兜底轮询间隔
const FALLBACK_REFRESH_MS = 60_000;

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const [portfolio, setPortfolio] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [trades, setTrades] = useState([]);
  const [news, setNews] = useState([]);
  const [stats, setStats] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [triggering, setTriggering] = useState(false);
  const [live, setLive] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [activeSymbol, setActiveSymbol] = useState(null);
  const toastId = useRef(0);

  const pushToast = useCallback((text, tone = '') => {
    const id = ++toastId.current;
    setToasts((prev) => [...prev.slice(-2), { id, text, tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [p, s, t, n, st, stt] = await Promise.all([
        api.portfolio(),
        api.snapshots(),
        api.trades(),
        api.news(),
        api.status(),
        api.stats(),
      ]);
      setPortfolio(p);
      setSnapshots(s);
      setTrades(t);
      setNews(n);
      setStatus(st);
      setStats(stt);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, FALLBACK_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // SSE 实时推送:报价/快照直接带数据,其余事件触发对应数据的增量拉取
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);

    es.addEventListener('portfolio', (e) => setPortfolio(JSON.parse(e.data)));
    es.addEventListener('snapshot', (e) => {
      const snap = JSON.parse(e.data);
      setSnapshots((prev) => [...prev, snap]);
    });
    es.addEventListener('news', () => api.news().then(setNews).catch(() => {}));
    es.addEventListener('analysis', (e) => {
      api.news().then(setNews).catch(() => {});
      try {
        const a = JSON.parse(e.data);
        if (a.tier && a.tier <= 2) {
          pushToast(
            `${a.sentiment === 'bullish' ? '利好' : '利空'}信号 ${a.symbol} · 第${a.tier}档`,
            a.sentiment === 'bullish' ? 'toast-up' : 'toast-down'
          );
        }
      } catch { /* 忽略畸形数据 */ }
    });
    es.addEventListener('trade', (e) => {
      api.trades().then(setTrades).catch(() => {});
      api.portfolio().then(setPortfolio).catch(() => {});
      api.stats().then(setStats).catch(() => {});
      try {
        const t = JSON.parse(e.data);
        const verb = t.side === 'buy' ? '买入' : '卖出';
        const prefix =
          t.trigger === 'stop_loss' ? '止损' : t.trigger === 'take_profit' ? '止盈' : '';
        pushToast(
          `${prefix}${verb} ${t.symbol} ${fmtNum(t.quantity, 4)} 股 @ ${fmtMoney(t.price)}`,
          t.side === 'buy' ? 'toast-up' : 'toast-down'
        );
      } catch { /* 忽略畸形数据 */ }
    });
    es.addEventListener('cycle', () => api.status().then(setStatus).catch(() => {}));

    return () => es.close();
  }, [pushToast]);

  const triggerCycle = async () => {
    setTriggering(true);
    try {
      await api.runCycle();
      setTimeout(refresh, 5000);
    } catch (err) {
      setError(err.message);
    } finally {
      setTriggering(false);
    }
  };

  const pnl = portfolio?.pnl ?? 0;
  const session = portfolio?.market_session;

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <h1>
            AI 新闻交易员
            <span className="subtitle">FMP 新闻 · DeepSeek 分析 · 美股模拟交易</span>
          </h1>
          <div className="header-actions">
            {session && (
              <span className={`badge badge-session session-${session}`}>
                {SESSION_LABELS[session]}
              </span>
            )}
            <span className={`live-indicator ${live ? 'on' : ''}`} title={live ? '已建立 SSE 实时连接' : '实时连接断开,使用兜底轮询'}>
              <span className="dot" />
              {live ? '实时' : '轮询'}
            </span>
            <button className="btn" onClick={triggerCycle} disabled={triggering || status?.running}>
              {status?.running ? '运行中…' : triggering ? '触发中…' : '立即分析一轮'}
            </button>
          </div>
        </div>
        {portfolio && (
          <div className="stats">
            <div className="stat">
              <span className="stat-label">总资产</span>
              <span className="stat-value">{fmtMoney(portfolio.total_value)}</span>
            </div>
            <div className="stat">
              <span className="stat-label">可用现金</span>
              <span className="stat-value">{fmtMoney(portfolio.cash)}</span>
            </div>
            <div className="stat">
              <span className="stat-label">持仓市值</span>
              <span className="stat-value">{fmtMoney(portfolio.positions_value)}</span>
            </div>
            <div className="stat">
              <span className="stat-label">总盈亏</span>
              <span className={`stat-value ${pnl >= 0 ? 'up' : 'down'}`}>
                {fmtMoney(pnl)} ({fmtPercent(portfolio.pnl_percent)})
              </span>
            </div>
          </div>
        )}
        {error && <div className="error-bar">{error}</div>}
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="content">
        {tab === 'dashboard' && (
          <Dashboard
            portfolio={portfolio}
            snapshots={snapshots}
            trades={trades}
            stats={stats}
            status={status}
            onSymbolClick={setActiveSymbol}
          />
        )}
        {tab === 'news' && <NewsFeed news={news} onSymbolClick={setActiveSymbol} />}
        {tab === 'trades' && <TradesPage trades={trades} onSymbolClick={setActiveSymbol} />}
      </main>

      <footer className="footer">
        模拟交易,不构成投资建议 · 数据来源 Financial Modeling Prep / Yahoo Finance · 分析引擎 DeepSeek
      </footer>

      <Toasts toasts={toasts} />
      {activeSymbol && <SymbolModal symbol={activeSymbol} onClose={() => setActiveSymbol(null)} />}
    </div>
  );
}
