import React from 'react';
import { Alert, Button, Card, Divider, Space, Table, Tag, Typography } from 'antd';

const { Title, Paragraph, Text } = Typography;

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

/**
 * 投资策略说明页(#/strategy):完整描述系统从新闻到下单的全流程策略。
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

        <Card size="small" title="一、策略总览">
          <Paragraph>
            本系统是一个<Text strong>新闻驱动的美股事件交易策略</Text>:持续抓取财经新闻,
            由 AI 大模型判断每条新闻对相关个股的利好/利空程度,把可信、重大且及时的信号转化为模拟买卖单,
            并在严格的服务端风控约束下管理仓位。核心理念是:
          </Paragraph>
          <ul>
            <li><Text strong>只交易重大事件</Text>——小道消息和轻微利好不动手;</li>
            <li><Text strong>来源可信度优先</Text>——同样的内容,权威媒体与不知名网站的权重完全不同;</li>
            <li><Text strong>资金分配看分数,不看先后</Text>——利好信号先入池排队,由分配器按质量统一分配资金;</li>
            <li><Text strong>风控全部代码硬约束</Text>——AI 只能在风控框架内做决定,越权即被拒绝。</li>
          </ul>
        </Card>

        <Card size="small" title="二、新闻获取与来源可信度">
          <Paragraph>
            系统全天候轮询多路财经新闻源(个股新闻、综合财经、公司公告),按 URL 去重后入库。
            每篇文章在入库时即按其<Text strong>原始来源域名</Text>打一个可信度分(0~1):
            权威通讯社与监管文件最高(约 0.95),主流财经媒体次之(约 0.85),
            观点平台打折(约 0.65),低可信站点与未知来源最低(0.4~0.5);
            经聚合渠道转发的文章再小幅扣分。这个分数会一路乘进后续的交易置信度里。
          </Paragraph>
        </Card>

        <Card size="small" title="三、AI 四档分类与最终置信度">
          <Paragraph>
            AI 分析师阅读每篇新文章,输出方向(利好/利空/中性)、影响程度、影响范围与置信度,
            程序据此把信号分为四档:
          </Paragraph>
          <ul>
            <li><Tag>第一档</Tag>程度大、范围大(如重磅财报爆雷、重大并购)</li>
            <li><Tag>第二档</Tag>程度大、范围小(如单一产品获批、大额订单)</li>
            <li><Tag>第三档</Tag>程度小、范围大(如行业政策微调)</li>
            <li><Tag>第四档</Tag>程度小、范围小(日常噪音)</li>
          </ul>
          <Paragraph>
            <Text strong>默认只有第一、二档信号有交易资格</Text>。最终置信度 = 来源可信度 × AI 置信度 ×
            时效衰减(1 小时内不打折,24 小时以上打五折)× 档位权重;低于门槛(默认 0.35)的信号只记录、不交易。
          </Paragraph>
        </Card>

        <Card size="small" title="四、事件去重与跨源确认">
          <Paragraph>
            同一事件往往被多家媒体反复报道。AI 会把新信号与该股票近 72 小时的历史事件比对,
            重复报道只累计计数、绝不重复交易。两个关键防错设计:
          </Paragraph>
          <ul>
            <li>
              <Text strong>公司通稿打折</Text>:新闻稿/公关通稿类来源的利好信号按 0.75 倍折扣——
              通稿天然带宣传性质,单独一篇通稿通常先挂起观察,等独立媒体跟进确认后再考虑交易;
            </li>
            <li>
              <Text strong>跨源确认</Text>:低置信度被挂起的事件,若后续有<Text strong>独立来源</Text>跟进报道,
              会按新来源的可信度加确认加成重新评估——单一低可信网站永远无法独自触发交易;
            </li>
            <li>同方向交易有 30 分钟冷却期;去重检查出错时宁可错过、绝不重复下单。</li>
          </ul>
        </Card>

        <Card size="small" title="五、标的准入门槛">
          <Paragraph>买入前先过硬性准入(全部代码判断,不经 AI):</Paragraph>
          <ul>
            <li>仅限纳斯达克 / 纽交所 / 美交所上市股票,自动排除场外与粉单市场;</li>
            <li>排除 ETF 与基金;</li>
            <li>市值不低于 3 亿美元、股价不低于 2 美元、日均成交额不低于 500 万美元;</li>
            <li>AI 还会核验新闻主体确实是该上市公司本身(防止把未上市公司映射到相似代码的股票)。</li>
          </ul>
        </Card>

        <Card size="small" title="六、候选池与资金分配">
          <Paragraph>
            通过门槛的利好信号<Text strong>不会立即成交</Text>,而是进入买入候选池。
            可交易时段(美东盘前 04:00 至盘后 20:00,含盘前/盘中/盘后)每 15 分钟运行一次资金分配:
            对池内候选重新打分(档位 × 置信度 × 时效衰减 × 来源分 × 宏观与行业乘数),
            解决多空冲突后按分数排序,只对排名最高的少数候选做出最终交易决策。这样:
          </Paragraph>
          <ul>
            <li>资金优先给最高质量的信号,而不是先到先得;</li>
            <li>资金不足时高分候选留池等待,资金释放后自动复评;</li>
            <li>持仓数已满或现金不足时,自动止盈一个最接近止盈价的盈利持仓为新候选腾位;</li>
            <li>休市(夜间/周末/假日)期间信号只累积、不交易,次日盘前第一轮统一清算隔夜候选;</li>
            <li>候选最长保留 24 小时,过期自动作废;同一股票出现反向信号时买入候选自动搁置。</li>
          </ul>
        </Card>

        <Card size="small" title="七、宏观环境层">
          <Paragraph>
            综合财经新闻(CPI、议息、就业、关税、地缘政治等)由 AI 单独分析为宏观事件,
            程序按档位、置信度与时间衰减聚合成一个 [-1, 1] 的风险评分,映射为四种宏观环境并直接约束买入行为:
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
            此外,重大经济数据(高重要性美国数据)发布前后约 30 分钟为<Text strong>黑窗期</Text>,
            期间暂停新的买入分配,避免在数据落地的剧烈波动中接飞刀;卖出与止损不受任何宏观限制。
          </Paragraph>
        </Card>

        <Card size="small" title="八、仓位规模与风控审批">
          <Paragraph>每笔买入金额经过一条逐级收紧的链路:</Paragraph>
          <Paragraph>
            AI 给出的目标仓位(占组合总值的比例,受可用现金约束)→ 档位/置信度/来源可信度三重折扣 →
            宏观环境与行业乘数 → 连续亏损后自动减仓 → 独立的 <Text strong>AI 风控官</Text>复审
            (可批准、压缩或一票否决,审批失败按否决处理)→ 代码硬上限。
          </Paragraph>
          <Paragraph>最终所有买入还必须通过组合级硬风控(全部代码强制,任何一条不过即拒单):</Paragraph>
          <ul>
            <li>单一持仓不超过组合的 25%,单笔买入不超过 20%,最小订单 50 美元,只做多、不加杠杆;</li>
            <li>单一行业市值占比不超过 35%;</li>
            <li>当日亏损超过阈值(默认 2%)触发熔断,当天停止一切买入;</li>
            <li>最多同时持有 15 只股票;</li>
            <li>按宏观环境执行现金保留下限、当日买入预算与总敞口上限的三重约束;</li>
            <li>成交前重新取报价,价格相对决策时漂移超过 5% 立即放弃,并按滑点模型模拟真实成交价。</li>
          </ul>
        </Card>

        <Card size="small" title="九、卖出、止损与持仓管理">
          <ul>
            <li>
              <Text strong>固定止损/止盈</Text>:每笔买入都按买入均价设定 ±2% 的止损与止盈线,
              盘前/盘中/盘后持续监控,触线即全仓卖出——窄敞口、快进快出;
            </li>
            <li>
              <Text strong>48 小时持有上限</Text>:任何持仓最长持有 48 小时,到期强制平仓;
              持有期间出现<Text strong>新的不同利好</Text>(一/二档,经事件去重)则持有时钟刷新回 48 小时,
              同时止盈线上抬 1 个百分点(逐次累加);
            </li>
            <li>
              <Text strong>利空即卖</Text>:持仓股票出现新的一/二档利空信号时,
              不经 AI 决策直接全仓卖出(卖出不入池、不受预算限制);
            </li>
            <li>
              <Text strong>止盈腾位</Text>:出现更好的新候选而容量/现金不足时,
              自动止盈一个最接近止盈价的盈利持仓,把资金轮换给新信号;
            </li>
            <li>
              <Text strong>每日持仓复查</Text>:每个交易日 AI 复盘全部持仓,
              买入逻辑已失效的仓位会被卖出或收紧止损;
            </li>
            <li>休市时段产生的卖出信号挂单排队,下一个可交易时段(含盘前)自动成交;盘前盘后按真实盘外价格即时成交。</li>
          </ul>
        </Card>

        <Card size="small" title="十、自我进化与信号质量评估">
          <ul>
            <li>
              <Text strong>交易复盘记忆</Text>:每笔平仓后 AI 提炼一条可迁移的经验教训,
              之后的交易决策与风控审批会带上最近的教训作为参考;
            </li>
            <li>
              <Text strong>信号质量回测</Text>:每个非中性信号都会记录信号时点价格,
              并回填 1 小时、1 天、5 天后的前瞻收益,持续度量「分类本身是否有超额收益」
              ——详见「信号质量」标签页;
            </li>
            <li>连续亏损时系统自动降低后续买入规模,直到重新盈利。</li>
          </ul>
        </Card>

        <Divider style={{ margin: '8px 0' }} />
        <Paragraph type="secondary" style={{ fontSize: 12.5, textAlign: 'center' }}>
          以上参数均为系统默认值,实际部署可调。本页内容仅说明系统逻辑,模拟交易结果不代表真实市场可获得的收益,
          亦不构成任何投资建议。
        </Paragraph>
      </Space>
    </div>
  );
}
