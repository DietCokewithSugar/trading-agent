import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Collapse, Space, Table, Tag, Typography } from 'antd';
import { api, fmtTime } from '../api.js';

const { Paragraph, Text } = Typography;

/** 各宏观环境下生效的组合参数(与服务端 macroRegimeParams 默认值一致,文案口径) */
const REGIME_ROWS = [
  { key: 'risk_on', regime: '风险偏好', budget: '较宽松', tiers: '一、二档', note: '正常买入,宏观乘数略放大' },
  { key: 'neutral', regime: '中性', budget: '标准', tiers: '一、二档', note: '默认参数' },
  { key: 'risk_off', regime: '避险', budget: '收紧', tiers: '仅第一档且高置信度', note: '提高现金保留、压缩买入金额' },
  { key: 'macro_shock', regime: '宏观冲击', budget: '暂停买入', tiers: '—', note: '重大避险事件后数小时内只卖不买' },
];

const REGIME_COLUMNS = [
  { title: '宏观环境', dataIndex: 'regime', width: 110, render: (v, r) => <Tag color={{ risk_on: 'green', neutral: 'default', risk_off: 'orange', macro_shock: 'red' }[r.key]}>{v}</Tag> },
  { title: '买入预算', dataIndex: 'budget', width: 100 },
  { title: '可交易档位', dataIndex: 'tiers', width: 160 },
  { title: '说明', dataIndex: 'note' },
];

/** 硬风控关键参数:一屏芯片墙,替代长段文字 */
const RISK_PARAMS = [
  { value: '±2%', label: '固定止损 / 止盈' },
  { value: '48 小时', label: '最长持有,到期平仓' },
  { value: '≤15 只', label: '最大同时持仓' },
  { value: '≤25%', label: '单一持仓占比' },
  { value: '≤20%', label: '单笔买入占比' },
  { value: '≤35%', label: '单一行业占比' },
  { value: '-2%', label: '当日亏损熔断线' },
  { value: '30 分钟', label: '同向交易冷却' },
  { value: '5%', label: '成交价漂移即放弃' },
  { value: '$50', label: '最小订单金额' },
];

/** 从新闻到平仓的策略流水线:折叠步骤,标题一句话可读完,细节按需展开 */
const PIPELINE_STEPS = [
  {
    title: '新闻获取与来源可信度',
    summary: '全天候多路抓取,入库即按来源域名打 0~1 可信度分',
    body: (
      <Paragraph style={{ marginBottom: 0 }}>
        系统全天候轮询多路财经新闻源(个股新闻、综合财经、公司公告),按 URL 去重后入库。
        每篇文章在入库时即按其<Text strong>原始来源域名</Text>打一个可信度分(0~1):
        权威通讯社与监管文件最高(约 0.95),主流财经媒体次之(约 0.85),
        观点平台打折(约 0.65),低可信站点与未知来源最低(0.4~0.5);
        经聚合渠道转发的文章再小幅扣分。这个分数会一路乘进后续的交易置信度里。
      </Paragraph>
    ),
  },
  {
    title: 'AI 四档分类与最终置信度',
    summary: '方向 × 程度 × 范围 → 四档信号,默认只有一、二档有交易资格',
    body: (
      <>
        <ul style={{ marginTop: 0 }}>
          <li><Tag>第一档</Tag>程度大、范围大(如重磅财报爆雷、重大并购)</li>
          <li><Tag>第二档</Tag>程度大、范围小(如单一产品获批、大额订单)</li>
          <li><Tag>第三档</Tag>程度小、范围大(如行业政策微调)</li>
          <li><Tag>第四档</Tag>程度小、范围小(日常噪音)</li>
        </ul>
        <Paragraph style={{ marginBottom: 0 }}>
          最终置信度 = 来源可信度 × AI 置信度 × 时效衰减(1 小时内不打折,24 小时以上打五折)×
          档位权重;低于门槛(默认 0.35)的信号只记录、不交易。
        </Paragraph>
      </>
    ),
  },
  {
    title: '事件去重与跨源确认',
    summary: '同一事件绝不重复交易;单一低可信来源永远无法独自触发交易',
    body: (
      <ul style={{ margin: 0 }}>
        <li>AI 将新信号与该股票近 72 小时的历史事件比对,重复报道只累计计数、绝不重复交易;</li>
        <li>
          <Text strong>公司通稿打折</Text>:新闻稿/公关通稿类来源的利好信号按 0.75 倍折扣——
          单独一篇通稿通常先挂起观察,等独立媒体跟进确认后再考虑交易;
        </li>
        <li>
          <Text strong>跨源确认</Text>:低置信度被挂起的事件,若后续有<Text strong>独立来源</Text>跟进报道,
          会按新来源的可信度加确认加成重新评估;
        </li>
        <li>同方向交易有 30 分钟冷却期;去重检查出错时宁可错过、绝不重复下单。</li>
      </ul>
    ),
  },
  {
    title: '标的准入门槛',
    summary: '只交易三大交易所的正常个股:市值 ≥ $3 亿、股价 ≥ $2、日均成交 ≥ $500 万',
    body: (
      <ul style={{ margin: 0 }}>
        <li>仅限纳斯达克 / 纽交所 / 美交所上市股票,自动排除场外与粉单市场;</li>
        <li>排除 ETF 与基金;</li>
        <li>市值不低于 3 亿美元、股价不低于 2 美元、日均成交额不低于 500 万美元;</li>
        <li>AI 还会核验新闻主体确实是该上市公司本身(防止把未上市公司映射到相似代码的股票)。</li>
      </ul>
    ),
  },
  {
    title: '候选池与资金分配',
    summary: '利好信号先入池排队,每 15 分钟按分数统一分配资金——看质量,不看先后',
    body: (
      <ul style={{ margin: 0 }}>
        <li>
          通过门槛的利好信号<Text strong>不会立即成交</Text>,而是进入买入候选池;
          可交易时段(美东盘前 04:00 至盘后 20:00)每 15 分钟运行一次资金分配,
          对池内候选重新打分(档位 × 置信度 × 时效衰减 × 来源分 × 宏观与行业乘数)后按分数排序,
          只对排名最高的少数候选做出最终交易决策;
        </li>
        <li>资金不足时高分候选留池等待,资金释放后自动复评;</li>
        <li>持仓数已满或现金不足时,自动止盈一个最接近止盈价的盈利持仓为新候选腾位;</li>
        <li>休市(夜间/周末/假日)期间信号只累积、不交易,次日盘前第一轮统一清算隔夜候选;</li>
        <li>候选最长保留 24 小时,过期自动作废;同一股票出现反向信号时买入候选自动搁置。</li>
      </ul>
    ),
  },
  {
    title: '宏观环境层',
    summary: '宏观新闻聚合成风险评分,分四档环境直接约束买入行为',
    body: (
      <>
        <Paragraph>
          综合财经新闻(CPI、议息、就业、关税、地缘政治等)由 AI 单独分析为宏观事件,
          程序按档位、置信度与时间衰减聚合成一个 [-1, 1] 的风险评分,映射为四种宏观环境:
        </Paragraph>
        <Table
          size="small"
          rowKey="key"
          columns={REGIME_COLUMNS}
          dataSource={REGIME_ROWS}
          pagination={false}
          scroll={{ x: 560 }}
        />
        <Paragraph style={{ marginTop: 12, marginBottom: 0 }}>
          此外,重大经济数据发布前后约 30 分钟为<Text strong>黑窗期</Text>,
          期间暂停新的买入分配;卖出与止损不受任何宏观限制。
        </Paragraph>
      </>
    ),
  },
  {
    title: '仓位规模与风控审批',
    summary: 'AI 只能在代码硬约束内做决定:逐级收紧的仓位链 + 独立风控官复审',
    body: (
      <>
        <Paragraph>
          AI 给出的目标仓位(占组合总值的比例,受可用现金约束)→ 档位/置信度/来源可信度三重折扣 →
          宏观环境与行业乘数 → 连续亏损后自动减仓 → 独立的 <Text strong>AI 风控官</Text>复审
          (可批准、压缩或一票否决,审批失败按否决处理)→ 代码硬上限。
        </Paragraph>
        <Paragraph style={{ marginBottom: 8 }}>
          最终所有买入还必须通过组合级硬风控(全部代码强制,任何一条不过即拒单),关键参数见上方芯片;
          此外按宏观环境执行现金保留下限、当日买入预算与总敞口上限的三重约束,
          成交前重新取报价并按滑点模型模拟真实成交价。
        </Paragraph>
        <Paragraph style={{ marginBottom: 0 }}>只做多、不加杠杆。</Paragraph>
      </>
    ),
  },
  {
    title: '卖出、止损与持仓管理',
    summary: '±2% 触线即卖 + 48 小时强制平仓 + 利空即卖,窄敞口快进快出',
    body: (
      <ul style={{ margin: 0 }}>
        <li><Text strong>固定止损/止盈</Text>:每笔买入按买入均价设定 ±2% 的止损与止盈线,盘前/盘中/盘后持续监控,触线即全仓卖出;</li>
        <li>
          <Text strong>48 小时持有上限</Text>:到期强制平仓;持有期间出现新的不同利好(一/二档,经事件去重)
          则持有时钟刷新回 48 小时,同时止盈线上抬 1 个百分点(逐次累加);
        </li>
        <li><Text strong>利空即卖</Text>:持仓股票出现新的一/二档利空信号时,不经 AI 决策直接全仓卖出(卖出不入池、不受预算限制);</li>
        <li><Text strong>止盈腾位</Text>:出现更好的新候选而容量/现金不足时,自动止盈一个最接近止盈价的盈利持仓,把资金轮换给新信号;</li>
        <li><Text strong>每日持仓复查</Text>:每个交易日 AI 复盘全部持仓,买入逻辑已失效的仓位会被卖出或收紧止损;</li>
        <li>休市时段产生的卖出信号挂单排队,下一个可交易时段(含盘前)自动成交;盘前盘后按真实盘外价格即时成交。</li>
      </ul>
    ),
  },
  {
    title: '自我进化与信号质量评估',
    summary: '每笔平仓提炼教训,每个信号回填前瞻收益,持续度量分类是否有超额收益',
    body: (
      <ul style={{ margin: 0 }}>
        <li><Text strong>交易复盘记忆</Text>:每笔平仓后 AI 提炼一条可迁移的经验教训,之后的交易决策与风控审批会带上最近的教训作为参考;</li>
        <li>
          <Text strong>信号质量回测</Text>:每个非中性信号都会记录信号时点价格,并回填 1 小时、1 天、5 天后的前瞻收益,
          持续度量「分类本身是否有超额收益」——详见「信号质量」标签页;
        </li>
        <li>连续亏损时系统自动降低后续买入规模,直到重新盈利。</li>
      </ul>
    ),
  },
];

/** 系统状态卡:运行节奏 + 上次运行结果(从仪表盘迁入,数据自行拉取) */
function SystemStatus() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.status().then((s) => !cancelled && setStatus(s)).catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!status) return null;
  const cadence = [
    { value: `${status.pollSeconds}s`, label: '新闻轮询' },
    { value: `${status.quotePushSeconds}s`, label: '报价推送' },
    { value: `${status.snapshotSeconds}s`, label: '净值快照' },
    { value: `${status.riskCheckSeconds}s`, label: '止损监控' },
  ];
  // 停牌监控(028):有生效中停牌时展示数量(全市场口径,持仓行另有停牌标记)
  if (status.halts && status.halts.active > 0) {
    cadence.push({ value: `${status.halts.active} 只`, label: '停牌监控' });
  }
  return (
    <Card size="small" title="系统状态">
      <div className="param-chips">
        {cadence.map((c) => (
          <span className="param-chip" key={c.label}>
            <b className="num">{c.value}</b>
            <span className="label-caps">{c.label}</span>
          </span>
        ))}
      </div>
      <Paragraph type="secondary" style={{ margin: '12px 0 0', fontSize: 12.5 }}>
        上次运行 {fmtTime(status.lastRunAt)}
        {status.lastResult &&
          ` · 新增新闻 ${status.lastResult.newArticles} · 分析 ${status.lastResult.analyzed} · 信号 ${status.lastResult.signals} · 成交 ${status.lastResult.trades}`}
      </Paragraph>
      {status.lastError && (
        <Paragraph style={{ margin: '6px 0 0', fontSize: 12.5 }}>
          <span className="down">错误:{status.lastError}</span>
        </Paragraph>
      )}
    </Card>
  );
}

/**
 * 投资策略说明页(#/strategy):从新闻到平仓的全流程策略,按流水线折叠展示。
 * 注意:公开文案不出现任何第三方数据/模型服务商名称。
 */
export default function StrategyPage() {
  return (
    <div className="app">
      <header className="header-top">
        <h1>投资策略说明</h1>
        <Button href="#/">返回仪表盘</Button>
      </header>

      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="本站为全自动的模拟交易实验"
          description="所有资金均为虚拟资金,不接入任何真实券商,不构成投资建议。系统的全部买卖决策由 AI 与代码规则自动完成,无人工干预。"
        />

        <Card size="small" title="策略一览">
          <Paragraph>
            一个<Text strong>新闻驱动的美股事件交易策略</Text>:持续抓取财经新闻,
            由 AI 判断每条新闻对相关个股的利好/利空程度,把可信、重大且及时的信号转化为模拟买卖单,
            并在严格的服务端风控约束下管理仓位。
          </Paragraph>
          <ul style={{ marginBottom: 0 }}>
            <li><Text strong>只交易重大事件</Text>——小道消息和轻微利好不动手;</li>
            <li><Text strong>来源可信度优先</Text>——同样的内容,权威媒体与不知名网站的权重完全不同;</li>
            <li><Text strong>资金分配看分数,不看先后</Text>——利好信号先入池排队,由分配器按质量统一分配资金;</li>
            <li><Text strong>风控全部代码硬约束</Text>——AI 只能在风控框架内做决定,越权即被拒绝。</li>
          </ul>
        </Card>

        <Card size="small" title="硬风控关键参数">
          <div className="param-chips">
            {RISK_PARAMS.map((p) => (
              <span className="param-chip" key={p.label}>
                <b className="num">{p.value}</b>
                <span className="label-caps">{p.label}</span>
              </span>
            ))}
          </div>
        </Card>

        <Card size="small" title="从新闻到平仓:决策流水线" styles={{ body: { paddingTop: 4, paddingBottom: 4 } }}>
          <Collapse
            ghost
            expandIconPosition="end"
            items={PIPELINE_STEPS.map((s, i) => ({
              key: String(i + 1),
              className: 'pipeline-step',
              label: (
                <span>
                  <span className="step-no">{String(i + 1).padStart(2, '0')}</span>
                  <Text strong>{s.title}</Text>
                  <span className="muted" style={{ marginLeft: 10, fontSize: 12.5 }}>{s.summary}</span>
                </span>
              ),
              children: s.body,
            }))}
          />
        </Card>

        <SystemStatus />

        <Paragraph type="secondary" style={{ fontSize: 12.5, textAlign: 'center', marginBottom: 0 }}>
          以上参数均为系统默认值,实际部署可调。本页内容仅说明系统逻辑,模拟交易结果不代表真实市场可获得的收益,
          亦不构成任何投资建议。
        </Paragraph>
      </Space>
    </div>
  );
}
