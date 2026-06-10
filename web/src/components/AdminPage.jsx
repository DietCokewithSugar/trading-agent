import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Space,
  Typography,
} from 'antd';
import { adminApi, fmtMoney, fmtTime } from '../api.js';

/**
 * 隐藏管理页(#/admin):
 * 输入 ADMIN_TOKEN 登录后,可查看调度状态、手动触发交易轮、全量初始化数据。
 */
export default function AdminPage() {
  const [token, setToken] = useState(() => sessionStorage.getItem('admin_token') || '');
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

  const login = async ({ token: input }) => {
    if (!input?.trim()) return;
    try {
      await verify(input.trim());
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
    <div className="app">
      <header className="header-top">
        <h1>
          管理后台{' '}
          <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>
            AI 新闻交易员 · 系统管理
          </Typography.Text>
        </h1>
        <Space>
          <Button href="#/">返回首页</Button>
          {authed && <Button onClick={logout}>退出登录</Button>}
        </Space>
      </header>

      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {error && <Alert type="error" message={error} showIcon />}
        {message && <Alert type="success" message={message} showIcon />}

        {!authed ? (
          <Card title="身份验证" style={{ maxWidth: 480 }}>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
              请输入服务端配置的 ADMIN_TOKEN(仅保存在当前浏览器会话中)。
            </Typography.Paragraph>
            <Form onFinish={login} layout="inline">
              <Form.Item name="token" style={{ flex: 1, marginRight: 8 }}>
                <Input.Password placeholder="ADMIN_TOKEN" autoFocus />
              </Form.Item>
              <Button type="primary" htmlType="submit">
                登录
              </Button>
            </Form>
          </Card>
        ) : (
          <>
            <Card title="运行状态">
              <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }}>
                <Descriptions.Item label="交易轮">
                  {status?.halted ? '已暂停(重置中)' : status?.running ? '运行中' : '空闲'}
                </Descriptions.Item>
                <Descriptions.Item label="上次运行">
                  {status?.lastRunAt ? fmtTime(status.lastRunAt) : '—'}
                </Descriptions.Item>
                <Descriptions.Item label="轮询间隔">
                  {status ? `${status.pollSeconds}s` : '—'}
                </Descriptions.Item>
                <Descriptions.Item label="SSE 在线">
                  {status ? `${status.sseClients} 个客户端` : '—'}
                </Descriptions.Item>
                <Descriptions.Item label="模型">{status?.model || '—'}</Descriptions.Item>
                <Descriptions.Item label="初始资金">
                  {status ? fmtMoney(status.initialCapital) : '—'}
                </Descriptions.Item>
              </Descriptions>
              {status?.lastError && (
                <Alert type="warning" message={`上次错误:${status.lastError}`} style={{ marginTop: 12 }} />
              )}
            </Card>

            <Card title="手动操作">
              <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
                立即执行一轮完整的「抓取 → 分析 → 交易」(全新闻源)。
              </Typography.Paragraph>
              <Button type="primary" onClick={triggerCycle} loading={busy} disabled={status?.running}>
                {status?.running ? '运行中…' : '立即执行一轮'}
              </Button>
            </Card>

            <Card title="危险区:初始化所有数据">
              <Alert
                type="warning"
                showIcon
                message="该操作不可恢复"
                description="清空全部新闻、AI 分析、事件、交易记录、持仓与净值快照,现金恢复为初始资金。"
                style={{ marginBottom: 12 }}
              />
              <Space wrap>
                <Input
                  placeholder="输入 RESET 确认"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  style={{ width: 200 }}
                />
                <Button danger type="primary" onClick={doReset} loading={busy} disabled={confirmText !== 'RESET'}>
                  初始化所有数据
                </Button>
              </Space>
            </Card>
          </>
        )}
      </Space>

      <footer className="footer">管理操作均需 ADMIN_TOKEN 鉴权 · 请勿泄露令牌</footer>
    </div>
  );
}
