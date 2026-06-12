import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  Row,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  adminApi,
  fmtMoney,
  fmtNum,
  fmtTime,
  LLM_PURPOSE_LABELS,
  REJECT_LABELS,
  RUN_TRIGGER_LABELS,
} from '../api.js';

/**
 * 隐藏管理页(#/admin):
 * 输入 ADMIN_TOKEN 登录后,可查看调度状态与运行指标、手动触发交易轮、全量初始化数据。
 */

// 最近运行表(cycle_runs):紧凑数字列 + 展开行查看完整错误
const RUN_COLUMNS = [
  {
    title: '开始时间',
    dataIndex: 'started_at',
    render: (v) => fmtTime(v),
    width: 110,
  },
  {
    title: '触发',
    dataIndex: 'trigger_source',
    render: (v) => RUN_TRIGGER_LABELS[v] || v,
    width: 60,
  },
  { title: '全量', dataIndex: 'full_fetch', render: (v) => (v ? '是' : '否'), width: 52 },
  { title: '新增', dataIndex: 'new_articles', width: 52 },
  { title: '分析', dataIndex: 'analyzed', width: 52 },
  { title: '信号', dataIndex: 'signals', width: 52 },
  { title: '去重', dataIndex: 'deduped', width: 52 },
  { title: '挂起', dataIndex: 'held', width: 52 },
  { title: '挂单', dataIndex: 'queued', width: 52 },
  { title: '成交', dataIndex: 'trades', width: 52 },
  {
    title: '用时',
    dataIndex: 'duration_ms',
    render: (v) => (v === null || v === undefined ? '—' : `${fmtNum(v, 0)}ms`),
    width: 80,
  },
  { title: 'LLM 调用', dataIndex: 'llm_calls', width: 76 },
  {
    title: '错误',
    dataIndex: 'errors',
    width: 56,
    render: (errors) => {
      const n = Array.isArray(errors) ? errors.length : 0;
      return n > 0 ? <Typography.Text type="danger">{n}</Typography.Text> : 0;
    },
  },
];
export default function AdminPage() {
  const [token, setToken] = useState(() => sessionStorage.getItem('admin_token') || '');
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [advisor, setAdvisor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [haltBusy, setHaltBusy] = useState(false);
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

  // 运行指标(最近运行/今日用量/队列):较重的聚合接口,降频到 15 秒
  useEffect(() => {
    if (!authed) return undefined;
    const load = () => adminApi.metrics(token).then(setMetrics).catch(() => {});
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [authed, token]);

  // 参数建议(近 30 天统计的重聚合):登录时拉一次,手动刷新
  useEffect(() => {
    if (!authed) return undefined;
    adminApi.advisor(token).then(setAdvisor).catch(() => {});
    return undefined;
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

  const toggleTradingHalt = async (halted) => {
    setHaltBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await adminApi.tradingHalt(token, halted);
      setMessage(
        `交易暂停开关已${result.halted ? '开启:停止开新仓' : '关闭:恢复正常交易'}${result.persisted ? '' : '(未持久化,重启后失效,请执行 013 迁移)'}`
      );
      // 立即重拉状态,开关显示与服务端对齐
      adminApi.status(token).then(setStatus).catch(() => {});
    } catch (err) {
      setError(err.message);
    } finally {
      setHaltBusy(false);
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

            <Card title="今日用量">
              <Row gutter={[16, 16]}>
                <Col xs={12} md={4}>
                  <Statistic title="LLM 调用" value={metrics?.today?.llm?.calls ?? '—'} />
                </Col>
                <Col xs={12} md={4}>
                  <Statistic
                    title="输入 tokens"
                    value={metrics ? fmtNum(metrics.today?.llm?.promptTokens ?? 0, 0) : '—'}
                  />
                </Col>
                <Col xs={12} md={4}>
                  <Statistic
                    title="输出 tokens"
                    value={metrics ? fmtNum(metrics.today?.llm?.completionTokens ?? 0, 0) : '—'}
                  />
                </Col>
                <Col xs={12} md={4}>
                  <Statistic
                    title="估算成本"
                    value={metrics ? fmtMoney(metrics.today?.llm?.cost ?? 0, 4) : '—'}
                  />
                </Col>
                <Col xs={12} md={4}>
                  <Statistic
                    title="行情源错误"
                    value={metrics?.today?.providerErrors?.fmp?.count ?? '—'}
                    valueStyle={
                      metrics?.today?.providerErrors?.fmp?.count > 0 ? { color: '#cf1322' } : undefined
                    }
                  />
                </Col>
                <Col xs={12} md={4}>
                  <Statistic
                    title="模型源错误"
                    value={metrics?.today?.providerErrors?.deepseek?.count ?? '—'}
                    valueStyle={
                      metrics?.today?.providerErrors?.deepseek?.count > 0
                        ? { color: '#cf1322' }
                        : undefined
                    }
                  />
                </Col>
              </Row>
              <Descriptions
                size="small"
                column={{ xs: 1, sm: 2, md: 3 }}
                style={{ marginTop: 16 }}
                title={<Typography.Text style={{ fontSize: 13 }}>分用途调用(美东当日,成本为按单价的估算值)</Typography.Text>}
              >
                {Object.entries(metrics?.today?.llm?.byPurpose || {}).map(([purpose, b]) => (
                  <Descriptions.Item key={purpose} label={LLM_PURPOSE_LABELS[purpose] || purpose}>
                    {b.calls} 次
                    {b.errors > 0 ? `(失败 ${b.errors})` : ''}
                    {b.calls > 0 ? ` · 均时 ${(b.latencyMsTotal / b.calls / 1000).toFixed(1)}s` : ''}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            </Card>

            <Card title="最近运行">
              {metrics && metrics.runsAvailable === false && (
                <Alert
                  type="info"
                  showIcon
                  message="运行指标未落库:cycle_runs 表不可用,请在数据库执行 012 迁移"
                  style={{ marginBottom: 12 }}
                />
              )}
              <Table
                size="small"
                rowKey="run_id"
                columns={RUN_COLUMNS}
                dataSource={metrics?.runs || []}
                loading={!metrics}
                pagination={false}
                scroll={{ x: 900 }}
                expandable={{
                  rowExpandable: (run) => Array.isArray(run.errors) && run.errors.length > 0,
                  expandedRowRender: (run) => (
                    <Typography.Paragraph style={{ margin: 0, fontSize: 12.5 }}>
                      {(run.errors || []).map((e, i) => (
                        <div key={i}>{e}</div>
                      ))}
                    </Typography.Paragraph>
                  ),
                }}
              />
            </Card>

            <Card title="队列与拒绝原因">
              <Row gutter={[16, 16]}>
                <Col xs={12} md={6}>
                  <Statistic title="分析积压(24h)" value={metrics?.backlog ?? '—'} />
                </Col>
                <Col xs={12} md={6}>
                  <Statistic title="待开盘挂单" value={metrics?.pendingOrders ?? '—'} />
                </Col>
                <Col xs={24} md={12}>
                  <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                    最近 {metrics?.runs?.length ?? 0} 轮的信号拒绝原因分布(信号未成交的原因画像,
                    可判断风控是否过严/太松)
                  </Typography.Text>
                  <div style={{ marginTop: 8 }}>
                    {Object.entries(metrics?.rejectReasons || {})
                      .sort((a, b) => b[1] - a[1])
                      .map(([reason, count]) => (
                        <Tag key={reason} style={{ marginBottom: 6 }}>
                          {REJECT_LABELS[reason] || reason} × {count}
                        </Tag>
                      ))}
                    {metrics && !Object.keys(metrics.rejectReasons || {}).length && (
                      <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                        暂无记录
                      </Typography.Text>
                    )}
                  </div>
                </Col>
              </Row>
            </Card>

            <Card
              title="参数建议(近 30 天)"
              extra={
                <Button
                  size="small"
                  onClick={() => adminApi.advisor(token).then(setAdvisor).catch(() => {})}
                >
                  刷新
                </Button>
              }
            >
              <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
                由信号前瞻收益统计(拦截层机会成本/来源/档位/置信度校准)与影子组合对照
                推导的参数调整建议——每条都带样本量与 95% 置信区间证据,样本不足或差异不显著的规则
                保持沉默。建议仅供参考,参数变更仍需人工通过环境变量执行。
              </Typography.Paragraph>
              {!advisor ? (
                <Typography.Text type="secondary">加载中…</Typography.Text>
              ) : advisor.available === false ? (
                <Alert type="info" showIcon message="信号前瞻收益数据不可用(需执行 011 迁移),无法生成建议" />
              ) : (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {(advisor.suggestions || []).map((s) => (
                    <Alert
                      key={s.id}
                      type={s.level === 'adjust' ? 'warning' : 'success'}
                      showIcon
                      message={s.title}
                      description={
                        <>
                          <div>{s.suggestion}</div>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            证据:{s.evidence}
                          </Typography.Text>
                        </>
                      }
                    />
                  ))}
                  {!advisor.suggestions?.length && (
                    <Alert
                      type="info"
                      showIcon
                      message="暂无可下结论的建议:各规则样本不足或表现差异不显著(这是正常状态,不是故障)"
                    />
                  )}
                  {Boolean(advisor.skipped?.length) && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      另有 {advisor.skipped.length} 条规则未评估:
                      {advisor.skipped.map((s) => `${s.title}(${s.reason})`).join(';')}
                    </Typography.Text>
                  )}
                </Space>
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

            <Card title="交易暂停开关">
              <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
                人工风控开关:开启后停止开新仓(新闻买入与开盘队列买单全部拦截),
                所有卖出(止损/止盈/持仓复查/新闻卖出)照常执行。状态跨重启保留。
                与「初始化数据」期间的系统自动暂停是两个独立机制。
              </Typography.Paragraph>
              <Space align="center" size={16}>
                <Switch
                  checked={status?.tradingHalted === true}
                  loading={haltBusy}
                  onChange={toggleTradingHalt}
                  checkedChildren="已暂停"
                  unCheckedChildren="正常"
                />
                {status?.tradingHalted ? (
                  <Alert
                    type="warning"
                    showIcon
                    message="已暂停开新仓:做多信号与开盘队列买单全部拦截,卖出与止损保护照常"
                    style={{ marginBottom: 0 }}
                  />
                ) : (
                  <Alert type="info" showIcon message="交易正常:未启用人工暂停" style={{ marginBottom: 0 }} />
                )}
              </Space>
              {status?.riskControls?.dailyLossTripped && (
                <Alert
                  type="warning"
                  showIcon
                  message={`当日亏损熔断已触发(阈值 -${status.riskControls.dailyLossHaltPercent}%):今日停止开新仓,次日自动恢复`}
                  style={{ marginTop: 12 }}
                />
              )}
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
