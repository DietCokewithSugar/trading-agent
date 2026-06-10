import React, { useEffect, useState, useCallback } from 'react';
import { api, fmtMoney, fmtPercent } from './api.js';
import Dashboard from './components/Dashboard.jsx';
import NewsFeed from './components/NewsFeed.jsx';
import TradesPage from './components/TradesPage.jsx';

const TABS = [
  { key: 'dashboard', label: '📈 仪表盘' },
  { key: 'news', label: '📰 新闻分析' },
  { key: 'trades', label: '🧾 交易记录' },
];

const REFRESH_MS = 60_000;

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const [portfolio, setPortfolio] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [trades, setTrades] = useState([]);
  const [news, setNews] = useState([]);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [triggering, setTriggering] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [p, s, t, n, st] = await Promise.all([
        api.portfolio(),
        api.snapshots(),
        api.trades(),
        api.news(),
        api.status(),
      ]);
      setPortfolio(p);
      setSnapshots(s);
      setTrades(t);
      setNews(n);
      setStatus(st);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

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

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <h1>
            🤖 AI 新闻交易员
            <span className="subtitle">FMP 新闻 × DeepSeek 分析 × 美股模拟交易</span>
          </h1>
          <button className="btn" onClick={triggerCycle} disabled={triggering || status?.running}>
            {status?.running ? '运行中…' : triggering ? '触发中…' : '⚡ 立即分析一轮'}
          </button>
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
        {error && <div className="error-bar">⚠️ {error}</div>}
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
          <Dashboard portfolio={portfolio} snapshots={snapshots} trades={trades} status={status} />
        )}
        {tab === 'news' && <NewsFeed news={news} />}
        {tab === 'trades' && <TradesPage trades={trades} />}
      </main>

      <footer className="footer">
        模拟交易,不构成投资建议 · 数据来源 Financial Modeling Prep / Yahoo Finance · 分析引擎 DeepSeek
      </footer>
    </div>
  );
}
