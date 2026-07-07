import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip,
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
  STRATEGY_LABELS,
  STRATEGY_DESCRIPTIONS,
  SHADOW_VARIANT_LABELS,
} from '../api.js';
import { COLOR_DOWN } from '../theme.js';

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
/**
 * 多券商模拟账户(025):添加多个券商模拟账户 API key,并给每个账户指派一个消融变体——
 * 该变体此后的每笔影子成交都以限价单发往对应账户,用真实盘口撮合复演消融实验。
 * secret 只在新增时上送,接口永不返回;key_id 脱敏展示。
 */
function BrokerAccountsCard({ token, onError, onMessage }) {
  const [data, setData] = useState(null);
  const [addBusy, setAddBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState(null); // 正在操作的账户 id
  const [form] = Form.useForm();

  const load = useCallback(() => {
    adminApi.brokerAccounts(token).then(setData).catch(() => {});
  }, [token]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);

  const addAccount = async (values) => {
    setAddBusy(true);
    onError(null);
    onMessage(null);
    try {
      const result = await adminApi.addBrokerAccount(token, {
        name: values.name,
        key_id: values.key_id,
        secret_key: values.secret_key,
        base_url: values.base_url || null,
      });
      onMessage(`券商模拟账户「${result.account.name}」已添加并通过连通性校验`);
      form.resetFields();
      load();
    } catch (err) {
      onError(err.message);
    } finally {
      setAddBusy(false);
    }
  };

  const updateAccount = async (id, patch, successText) => {
    setRowBusy(id);
    onError(null);
    onMessage(null);
    try {
      await adminApi.updateBrokerAccount(token, id, patch);
      if (successText) onMessage(successText);
      load();
    } catch (err) {
      onError(err.message);
    } finally {
      setRowBusy(null);
    }
  };

  const removeAccount = async (id, name) => {
    setRowBusy(id);
    onError(null);
    onMessage(null);
    try {
      await adminApi.deleteBrokerAccount(token, id);
      onMessage(`券商模拟账户「${name}」已删除(券商侧未成交单已尽力撤销)`);
      load();
    } catch (err) {
      onError(err.message);
    } finally {
      setRowBusy(null);
    }
  };

  const purposeOptions = [
    { value: '', label: '闲置(不执行)' },
    ...(data?.purposes || []).map((p) => ({
      value: p,
      label: SHADOW_VARIANT_LABELS[p] || p,
    })),
  ];

  const columns = [
    { title: '名称', dataIndex: 'name', width: 120, ellipsis: true },
    {
      title: 'API Key',
      dataIndex: 'key_id_masked',
      width: 130,
      render: (v) => <span className="mono">{v}</span>,
    },
    {
      title: '用途(执行的消融变体)',
      dataIndex: 'purpose',
      width: 210,
      render: (v, row) => (
        <Select
          size="small"
          style={{ width: '100%' }}
          value={v || ''}
          disabled={rowBusy === row.id}
          options={purposeOptions}
          onChange={(next) =>
            updateAccount(
              row.id,
              { purpose: next || null },
              next
                ? `「${row.name}」已指派用途:${SHADOW_VARIANT_LABELS[next] || next}(此后该变体的每笔影子成交都会发往该账户)`
                : `「${row.name}」已设为闲置`
            )
          }
        />
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (v, row) =>
        v === 'ok' ? (
          <Tag color="green">正常</Tag>
        ) : v === 'error' ? (
          <Tooltip title={row.last_error || ''}>
            <Tag color="red">异常</Tag>
          </Tooltip>
        ) : (
          <Tag>未校验</Tag>
        ),
    },
    {
      title: '账户净值',
      dataIndex: 'equity',
      width: 110,
      align: 'right',
      render: (v) => (v === null || v === undefined ? '—' : <span className="num">{fmtMoney(v)}</span>),
    },
    {
      title: '影子净值',
      dataIndex: 'shadow_total_value',
      width: 110,
      align: 'right',
      render: (v) => (v === null || v === undefined ? '—' : <span className="num">{fmtMoney(v)}</span>),
    },
    {
      title: '成交/总单',
      key: 'stats',
      width: 90,
      align: 'right',
      render: (_, row) => (
        <span className="num">
          {row.stats ? `${row.stats.filled}/${row.stats.orders}` : '—'}
        </span>
      ),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 70,
      render: (v, row) => (
        <Switch
          size="small"
          checked={v}
          loading={rowBusy === row.id}
          onChange={(next) =>
            updateAccount(row.id, { enabled: next }, `「${row.name}」已${next ? '启用' : '停用'}`)
          }
        />
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 80,
      render: (_, row) => (
        <Popconfirm
          title={`删除账户「${row.name}」?`}
          description="将尽力撤销该账户在券商侧的未成交单;历史执行单与快照一并删除。"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => removeAccount(row.id, row.name)}
        >
          <Button size="small" danger loading={rowBusy === row.id}>
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Card title="券商模拟账户(消融实验真实撮合)">
      <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
        可添加多个券商模拟账户(API key 加密通道上送,密钥只存服务端、永不回显)。
        给账户指派一个消融变体后,该变体的每笔影子成交都会以「限价单」同步发往该账户,
        用真实盘口撮合复演消融实验——账户净值与影子净值的偏离,就是该策略经真实撮合检验后的水分。
        同一变体最多绑定一个账户;重新指派不会迁移或清空券商侧既有持仓(建议换用途前先在券商侧清仓)。
      </Typography.Paragraph>

      {data?.available === false ? (
        <Alert
          type="info"
          showIcon
          message="多券商模拟账户功能不可用:broker_accounts 表缺失,请在数据库执行 025 迁移"
          style={{ marginBottom: 12 }}
        />
      ) : (
        <>
          <Table
            size="small"
            rowKey="id"
            columns={columns}
            dataSource={data?.accounts || []}
            loading={!data}
            pagination={false}
            scroll={{ x: 900 }}
            locale={{ emptyText: '尚未添加券商模拟账户' }}
            style={{ marginBottom: 16 }}
          />
          <Typography.Text type="secondary" className="label-caps">
            添加账户
          </Typography.Text>
          <Form
            form={form}
            layout="inline"
            onFinish={addAccount}
            style={{ marginTop: 8, rowGap: 8 }}
          >
            <Form.Item name="name" rules={[{ required: true, message: '请输入名称' }]}>
              <Input placeholder="账户名称(如:即时腾位实验)" style={{ width: 200 }} />
            </Form.Item>
            <Form.Item name="key_id" rules={[{ required: true, message: '请输入 Key ID' }]}>
              <Input placeholder="API Key ID" style={{ width: 180 }} autoComplete="off" />
            </Form.Item>
            <Form.Item name="secret_key" rules={[{ required: true, message: '请输入 Secret' }]}>
              <Input.Password placeholder="API Secret" style={{ width: 200 }} autoComplete="new-password" />
            </Form.Item>
            <Form.Item name="base_url">
              <Input placeholder="接口地址(可选,默认官方模拟盘)" style={{ width: 240 }} />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={addBusy}>
              校验并添加
            </Button>
          </Form>
        </>
      )}
    </Card>
  );
}

export default function AdminPage() {
  const [token, setToken] = useState(() => sessionStorage.getItem('admin_token') || '');
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [advisor, setAdvisor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [haltBusy, setHaltBusy] = useState(false);
  const [strategyBusy, setStrategyBusy] = useState(false);
  const [ledgerBusy, setLedgerBusy] = useState(false);
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

  const changeStrategy = async (strategy) => {
    setStrategyBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await adminApi.setStrategy(token, strategy);
      setMessage(`主账户交易策略已切换为「${STRATEGY_LABELS[result.strategy] || result.strategy}」`);
      adminApi.status(token).then(setStatus).catch(() => {});
    } catch (err) {
      setError(err.message);
    } finally {
      setStrategyBusy(false);
    }
  };

  const togglePrimaryLedger = async (enabled) => {
    setLedgerBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await adminApi.primaryLedger(token, enabled);
      setMessage(
        `展示主账本已切换为${result.enabled ? '券商模拟账户:仪表盘主视图展示真实撮合数据' : '内部模拟账本'}`
      );
      adminApi.status(token).then(setStatus).catch(() => {});
    } catch (err) {
      setError(err.message);
    } finally {
      setLedgerBusy(false);
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
                      metrics?.today?.providerErrors?.fmp?.count > 0 ? { color: COLOR_DOWN } : undefined
                    }
                  />
                </Col>
                <Col xs={12} md={4}>
                  <Statistic
                    title="模型源错误"
                    value={metrics?.today?.providerErrors?.deepseek?.count ?? '—'}
                    valueStyle={
                      metrics?.today?.providerErrors?.deepseek?.count > 0
                        ? { color: COLOR_DOWN }
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

            <Card title="主账户交易策略">
              <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
                策略预设与「消融实验」中的影子变体一一对应:先看实验里哪个变体持续跑赢,
                再在这里切换实盘策略。出场类只改止损/止盈/时限;入场类(即时成交/腾位/等权)
                绕过候选池、LLM 决策与风控官——锁内硬风控(暂停开关/亏损熔断/仓位帽/
                行业集中度等)对所有策略始终生效。状态跨重启保留。
              </Typography.Paragraph>
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Select
                  style={{ minWidth: 280 }}
                  value={status?.tradingStrategy || 'default'}
                  loading={strategyBusy}
                  disabled={strategyBusy}
                  onChange={changeStrategy}
                  options={Object.entries(STRATEGY_LABELS).map(([value, label]) => ({ value, label }))}
                />
                <Alert
                  type={
                    !status?.tradingStrategy || status.tradingStrategy === 'default' ? 'info' : 'warning'
                  }
                  showIcon
                  message={
                    STRATEGY_DESCRIPTIONS[status?.tradingStrategy || 'default'] ||
                    STRATEGY_DESCRIPTIONS.default
                  }
                  style={{ marginBottom: 0 }}
                />
              </Space>
            </Card>

            <Card title="展示主账本">
              <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
                开启后仪表盘主视图(净值/持仓/净值曲线)切换为券商模拟账户的真实撮合数据
                (盈亏基线为最早一条对照快照的净值);交易引擎、绩效统计与决策仍完全基于
                内部模拟账本,券商取数失败时主视图自动回退内部账本。状态跨重启保留。
              </Typography.Paragraph>
              <Space align="center" size={16}>
                <Switch
                  checked={status?.brokerLedgerPrimary === true}
                  loading={ledgerBusy}
                  disabled={!status?.brokerMirrorAvailable && status?.brokerLedgerPrimary !== true}
                  onChange={togglePrimaryLedger}
                  checkedChildren="券商模拟"
                  unCheckedChildren="内部账本"
                />
                {!status?.brokerMirrorAvailable ? (
                  <Alert
                    type="warning"
                    showIcon
                    message="券商模拟账户未配置(缺少 API key),无法设为主账本"
                    style={{ marginBottom: 0 }}
                  />
                ) : status?.brokerLedgerPrimary ? (
                  <Alert
                    type="info"
                    showIcon
                    message="主视图数据源:券商模拟账户(真实撮合价);内部账本降为对照"
                    style={{ marginBottom: 0 }}
                  />
                ) : (
                  <Alert type="info" showIcon message="主视图数据源:内部模拟账本(默认)" style={{ marginBottom: 0 }} />
                )}
              </Space>
            </Card>

            <BrokerAccountsCard token={token} onError={setError} onMessage={setMessage} />

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
