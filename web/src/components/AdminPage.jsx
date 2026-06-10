import React, { useCallback, useEffect, useState } from 'react';
import { adminApi, fmtMoney, fmtTime } from '../api.js';

/**
 * 隐藏管理页(#/admin):
 * 输入 ADMIN_TOKEN 登录后,可查看调度状态、手动触发交易轮、全量初始化数据。
 */
export default function AdminPage() {
  const [token, setToken] = useState(() => sessionStorage.getItem('admin_token') || '');
  const [input, setInput] = useState('');
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [message, setMessage] = useState(null);

  const verify = useCallback(async (t) => {
    await adminApi.verify(t);
    sessionStorage.setItem('admin_token', t);
    setToken(t);
    setAuthed(true);
    setError(null);
  }, []);

  // 已有会话 token 时自动登录
  useEffect(() => {
    if (token && !authed) {
      verify(token).catch((err) => {
        sessionStorage.removeItem('admin_token');
        setToken('');
        setError(err.message);
      });
    }
  }, [token, authed, verify]);

  // 登录后定时刷新状态
  useEffect(() => {
    if (!authed) return undefined;
    const load = () => adminApi.status(token).then(setStatus).catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [authed, token]);

  const login = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    try {
      await verify(input.trim());
      setInput('');
    } catch (err) {
      setError(err.message);
    }
  };

  const logout = () => {
    sessionStorage.removeItem('admin_token');
    setToken('');
    setAuthed(false);
    setStatus(null);
  };

  const triggerCycle = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await adminApi.runCycle(token);
      setMessage('已触发一轮全源抓取/分析/交易');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const doReset = async () => {
    if (confirmText !== 'RESET') return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await adminApi.reset(token);
      setConfirmText('');
      setMessage(
        `全量数据已初始化,现金恢复为 ${fmtMoney(result.initial_capital)}(${fmtTime(result.reset_at)})`
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app admin-page">
      <header className="header">
        <div className="header-top">
          <h1>
            管理后台
            <span className="subtitle">AI 新闻交易员 · 系统管理</span>
          </h1>
          <div className="header-actions">
            <a className="btn btn-secondary" href="#/">
              返回首页
            </a>
            {authed && (
              <button className="btn btn-secondary" onClick={logout}>
                退出登录
              </button>
            )}
          </div>
        </div>
        {error && <div className="error-bar">{error}</div>}
        {message && <div className="admin-message">{message}</div>}
      </header>

      <main className="content">
        {!authed ? (
          <div className="card admin-login">
            <h2>身份验证</h2>
            <p className="muted small">请输入服务端配置的 ADMIN_TOKEN(仅保存在当前浏览器会话中)。</p>
            <form onSubmit={login} className="admin-form">
              <input
                type="password"
                className="search-input"
                placeholder="ADMIN_TOKEN"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                autoFocus
              />
              <button className="btn" type="submit" disabled={!input.trim()}>
                登录
              </button>
            </form>
          </div>
        ) : (
          <>
            <div className="card">
              <h2>运行状态</h2>
              <div className="status-grid">
                <div>
                  <span className="muted">交易轮</span>
                  {status?.halted ? '已暂停(重置中)' : status?.running ? '运行中' : '空闲'}
                </div>
                <div>
                  <span className="muted">上次运行</span>
                  {status?.lastRunAt ? fmtTime(status.lastRunAt) : '—'}
                </div>
                <div>
                  <span className="muted">轮询间隔</span>
                  {status ? `${status.pollSeconds}s` : '—'}
                </div>
                <div>
                  <span className="muted">SSE 在线</span>
                  {status ? `${status.sseClients} 个客户端` : '—'}
                </div>
                <div>
                  <span className="muted">模型</span>
                  {status?.model || '—'}
                </div>
                <div>
                  <span className="muted">初始资金</span>
                  {status ? fmtMoney(status.initialCapital) : '—'}
                </div>
              </div>
              {status?.lastError && (
                <p className="muted small">上次错误:{status.lastError}</p>
              )}
            </div>

            <div className="card">
              <h2>手动操作</h2>
              <p className="muted small">立即执行一轮完整的「抓取 → 分析 → 交易」(全新闻源)。</p>
              <button className="btn" onClick={triggerCycle} disabled={busy || status?.running}>
                {status?.running ? '运行中…' : '立即执行一轮'}
              </button>
            </div>

            <div className="card admin-danger">
              <h2>危险区:初始化所有数据</h2>
              <p className="muted small">
                清空全部新闻、AI 分析、事件、交易记录、持仓与净值快照,现金恢复为初始资金。
                该操作不可恢复。输入 <b>RESET</b> 后方可执行。
              </p>
              <div className="admin-form">
                <input
                  type="text"
                  className="search-input"
                  placeholder="输入 RESET 确认"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                />
                <button
                  className="btn btn-danger"
                  onClick={doReset}
                  disabled={busy || confirmText !== 'RESET'}
                >
                  {busy ? '执行中…' : '初始化所有数据'}
                </button>
              </div>
            </div>
          </>
        )}
      </main>

      <footer className="footer">管理操作均需 ADMIN_TOKEN 鉴权 · 请勿泄露令牌</footer>
    </div>
  );
}
