# AI 新闻交易员 — 基于新闻的美股模拟交易网站

自动抓取财经新闻 → DeepSeek 判断利好/利空(四档分级)→ 基于信号自动模拟买卖美股 → 网页实时展示盈亏曲线、持仓、交易记录与买卖原因。无需登录,所有人公开可见。

## 工作流程

```
┌─────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ 新闻源       │ → │ DeepSeek 分析 │ → │ 候选池+分配器 │ → │ 网页展示      │
│ FMP 个股新闻 │   │ 个股:四档分级 │   │ 统一打分排序  │   │ 盈亏折线图    │
│ FMP 综合新闻 │   │ 宏观:环境分类 │   │ DeepSeek 决策 │   │ 持仓/交易记录 │
│ FMP 公司公告 │   │ 置信度+理由   │   │ FMP 实时报价  │   │ 宏观环境/候选 │
│ Yahoo RSS   │   └──────────────┘   │ 风控约束      │   └──────────────┘
│ FMP 经济日历 │          ↓           └──────────────┘          ↑
└─────────────┘  ┌────────────────── Supabase 数据库 ──────────────────┐
```

### 利好/利空四档分级

| 档位 | 影响程度 | 影响范围 |
|------|---------|---------|
| 第一档 | 大 | 大 |
| 第二档 | 大 | 小 |
| 第三档 | 小 | 大 |
| 第四档 | 小 | 小 |

默认只有第一、二档信号会触发交易决策(可通过 `TRADE_TIER_THRESHOLD` 调整)。交易由 DeepSeek 结合组合状态决定买卖与仓位,并受服务端风控约束(单股仓位 ≤25% 总资产、单笔买入 ≤20% 总资产、不允许做空)。

### 交易标的核验

新闻分析容易把"未上市公司"映射到名称相似的已上市代码(典型错误:SpaceX 的 IPO 新闻被映射到 SPCE,而 SPCE 是 Virgin Galactic)。系统在两个层面拦截:

1. **分析阶段**:DeepSeek 被明确要求,新闻主体若是未上市/即将 IPO 的私有公司,一律判定为不可交易,严禁映射到相似代码;
2. **决策阶段**:交易前拉取 FMP 公司档案(公司名称、交易所、行业、市值、IPO 日期、是否正常交易、52 周区间、日均成交量),连同实时报价一起交给 DeepSeek 做标的核验——新闻主体与报价公司是否同一家、股价/市值量级与新闻内容是否自洽(如新闻称 IPO 定价 175 美元而报价只有 4.59 美元即判定映射错误)。核验不通过强制 hold,绝不下单;档案显示已退市/停牌的代码由服务端直接跳过。

### 新闻事件溯源去重

同一底层事件(同一份公告/合作/财报)经常被多家媒体以不同标题重复报道,如果每条报道都独立触发交易,就会对同一利好反复加仓。系统的处理:

1. 分析阶段为每条新闻提炼一句"事件概要"(写"发生了什么",与报道角度无关);
2. 可交易信号先在 `news_events` 表内做事件归并:先用确定性的标题/事件归纳相似度兜底(`EVENT_NEAR_DUP_SIMILARITY`,同源新闻稿易绕过 LLM 去重),未命中再由 DeepSeek 对比该股票近 `EVENT_DEDUP_HOURS`(默认 72)小时内的已记录事件,判断是否为重复报道/跟进报道;
3. 重复报道只累计报道数,不再触发交易;只有真正的新事件才放行;
4. 新事件放行前再过一道同向交易冷却期(`TRADE_COOLDOWN_MINUTES`,默认 30 分钟),作为 LLM 误判的兜底;去重检查全部不可用时保守跳过,宁可错过也不重复下单。

### 新闻来源可信度与交叉确认

抓取渠道(新闻聚合 API、RSS)只是"发现层",真正决定信号质量的是**原始新闻来源**。系统按文章原文 URL 的域名(其次按发布方名称)给来源打可信度分(009 迁移):

| 来源层级 | 评分 | 示例 |
|---------|------|------|
| 权威通讯社 / 监管 | 0.95 | Reuters、AP、SEC |
| 公司公告 / 新闻稿 | 0.90 | PR Newswire、Business Wire、GlobeNewswire |
| 主流财经媒体 | 0.85 | Bloomberg、WSJ、FT、CNBC、Yahoo Finance |
| 观点 / 分析平台 | 0.65 | Motley Fool、Seeking Alpha、MarketWatch |
| 低可信来源 | 0.50 | Benzinga、Moneywise 等 |
| 未知小站 | 0.40 | 不在名单内的域名 |
| 无原文链接 | 0.25 | 连文章 URL 都没有的条目 |

经聚合 API 转发的文章在原始来源分上再扣 0.03 的聚合折价(折价后下限 0.2)。在此之上计算**综合置信度** = 来源可信度 × 分析置信度 × 时效分(1 小时内 1.0,24 小时以上 0.5)× 事件档位分:

- 综合置信度 ≥ `MIN_FINAL_CONFIDENCE`(默认 0.35)的信号正常进入交易决策;
- 低于门槛的信号**挂起**:事件照常记录但不交易,等待交叉确认;
- 挂起事件若收到**独立信源**(此前未出现过的域名)的同事件报道,按新报道自身的综合置信度叠加交叉确认加成(每多一个独立信源 +10%,上限 ×1.2)重新评估,通过即放行——单一小站的传闻不动手,权威信源跟进确认后才入场;
- 来源可信度同时作为仓位缩放链的一环(0.6~1 倍),并注入交易员与风控官的决策上下文。

### 止损 / 止盈 / 移动止损

每次买入时,DeepSeek 会根据新闻强度与股票波动性同时设定**止损价**(成本价下方 3%~15%)和**止盈价**(上方 5%~30%),存储在持仓上。服务端每 `RISK_CHECK_SECONDS`(默认 30 秒)监控一次持仓价格(含盘前盘后),跌破止损价或触及止盈价即自动全仓卖出,交易记录中会标注「自动止损 / 自动止盈」及详细原因。加仓时按新的平均成本重新设定。在本功能上线前已存在的持仓没有止损价,可在 Supabase 中手动 `update positions set stop_loss=..., take_profit=...` 补设。

**移动止损**(007 迁移,`ENABLE_TRAILING_STOP` 默认开):股价创出建仓后新高时,止损价按买入时设定的止损距离跟随上抬(峰值价 × (1 − 原止损距离)),只升不降、止盈价不动,浮盈越大保护越紧。

### 仓位缩放与每日持仓复查

- **按信号质量缩放仓位**(参考 [Lopez-Lira & Tang](https://arxiv.org/abs/2304.07619):信号强度应映射到仓位):在 LLM 给出的买入比例之上,按档位(一档 ×1.0、二档 ×0.7)、置信度(0.5→×0.5,1.0→×1.0)与来源可信度(0.6~1 倍)叠加缩放,最终仍受硬性风控帽(单股 ≤25%、单笔 ≤20%)约束;
- **每日持仓复查**(`ENABLE_POSITION_REVIEW` 默认开):新闻驱动的买入论点有时效性。每个交易日美东 `POSITION_REVIEW_HOUR`(默认 14)点后,DeepSeek 用**一次调用**整体评估全部持仓——论点已失效的主动卖出(交易标注「持仓复查」)、浮盈较大的收紧止损、健康的维持持有,防止过期论点的持仓长期滞留。

### 盘前盘后价格与交易日历

非盘中时段,系统通过 FMP 的 aftermarket-trade 接口获取盘前(美东 4:00–9:30)/盘后(16:00–20:00)最新成交价,用于估值、模拟成交和止损监控;页面持仓表会显示「盘前 / 盘后」徽章及相对收盘价的涨跌幅。若订阅不含该端点,自动退回收盘价。

市场时段判断内置 NYSE 交易日历(按规则计算,不会过期):全天休市假日(含耶稣受难日等浮动假日与固定假日的周末观察日)直接按休市处理,7/3、感恩节次日、平安夜等半日市 13:00 提前收盘;止损监控、快照降频、报价推送在假日自动停止,夏普等日度指标也只统计实际交易日。

### 模拟成交真实化(滑点 / 点差 / 漂移熔断)

新闻驱动策略的真实瓶颈是执行成本:消息后往往买在 spike、盘前盘后点差大、小盘股流动性差。为避免系统性高估收益,模拟成交做了三层处理:

- **下单时重取报价**:LLM 决策可能耗时数十秒甚至更久,买卖都在下单瞬间重新拉取最新价格成交,绝不按"消息发布瞬间的价格"成交;
- **漂移熔断**:下单时最新价相对决策时价格偏移超过 `BUY_PRICE_DRIFT_ABORT_PERCENT`(默认 5%)即放弃买入——上漂是追高,下漂说明行情已反转;
- **滑点模型**(`ENABLE_SLIPPAGE` 默认开):成交价在最新市场价上施加不利偏移(买更贵、卖更便宜),滑点 = 按市值分档的半点差(超大盘 1bp ~ 微盘 30bp)× 时段乘数(盘前盘后 ×3)× **开盘窗口乘数**(开盘后前 `OPENING_WINDOW_MINUTES`(默认 15)分钟点差最宽,额外 ×`OPENING_SLIPPAGE_MULT`(默认 2)——开盘首轮清算隔夜候选与开盘队列成交都落在这个窗口)× 当日波动乘数 + 订单冲击(按占日均美元成交额比例)+ 可选佣金(`COMMISSION_BPS`),单笔封顶 `SLIPPAGE_MAX_BPS`(默认 150bp)。每笔交易的市场参考价与实际滑点记录在 `trades.quote_price / slippage_bps`(008 迁移);
- **开盘队列**(010 迁移):休市时段(夜间/周末/假日)产生的信号**不再按上一收盘价立即成交**——真实世界里隔夜新闻只能在次日开盘竞价成交,隔夜跳空动辄数个百分点,按 stale 价成交等于把市场兑现的跳空记成策略收益。这类信号挂入 `pending_orders` 表(交易页可见「待开盘订单」),下一个常规交易时段以**当日开盘价 + 盘中滑点**成交;超过 `PENDING_ORDER_MAX_AGE_HOURS`(默认 96 小时,覆盖周末长假)未成交自动作废。盘前盘后有真实成交价,仍按 aftermarket 价立即成交。

### 标的准入门槛与公告降权

FMP 全市场新闻流会带出大量微盘股,其中不少"利好"是付费拉抬;新闻稿通道(PR Newswire / GlobeNewswire 等)真实性高但立场天然偏多。两道防线:

- **准入门槛**(只约束买入,卖出/止损永远放行):交易所白名单 `ALLOWED_EXCHANGES`(默认 NASDAQ/NYSE/AMEX,自动屏蔽 OTC/粉单)、ETF/基金过滤(公司新闻管线不交易 ETF)、最小市值 `MIN_MARKET_CAP`(默认 $3 亿)、最低股价 `MIN_PRICE`(默认 $2)、最低日均美元成交额 `MIN_AVG_DOLLAR_VOLUME`(默认 $500 万),在 LLM 决策之前由服务端硬性拦截,档案数据缺失按不通过处理(fail-closed);确定性硬规则先行,LLM 的标的核验是第二层;
- **公告利好降权**:公司公告类来源的**利好**信号在置信度门槛比较时折价 `PRESS_BULLISH_PENALTY`(默认 ×0.75),折价后多数会落入"挂起等待交叉确认"流程——只有独立媒体(非新闻稿通道)跟进报道后才解锁交易;利空公告不折价(公司主动披露利空可信度反而高)。

### 信号质量评估(前瞻收益)

组合盈亏混杂了仓位缩放、止损、风控官等环节,回答不了"**AI 的新闻分类本身有没有 alpha**"。系统为此单独建了一个评估层(011 迁移):

- 每条非中性分析在产生时记录**信号时点市场价**(`signal_price`),**包括因事件去重、置信度不足而未实际交易的信号**;
- 后台任务自动回填三个口径的前瞻收益:信号后 1 小时(实时价,休市窗口错过则缺省)、信号日后第 1 / 第 5 个交易日收盘价;
- 前端「信号质量」页(`/api/signal-stats`)汇总:按**事件档位 / 来源可信度 / 分析置信度 / 实际交易 vs 拦截层 / 入池时宏观环境 / 执行路径与排队时长**分桶的方向命中率与平均前瞻收益(按信号方向调整,利空跌了算命中),以及综合置信度与收益的相关系数(IC)、置信度校准(置信度分桶命中率是否单调上升);
- **时间窗口与样本透明**(017 后续):页面可切 7 天 / 30 天 / 全部(`?days=`),后端分页拉取突破单次 1000 行上限(全量超过 `SIGNAL_STATS_MAX_ROWS` 采样上限,默认 20000,时截断并明示实际覆盖的起点;上限偏低时较早已成熟的信号会被新信号挤出窗口,导致 1d/5d 统计逐渐消失);每个命中率都带 **Wilson 95% 置信区间**,且仅在区间整体高于/低于 50% 时才着色——区间跨过 50% 说明样本不足以下结论,防止 20 条样本就调参;
- **拦截层机会成本**:被资金受限 / 宏观过滤 / 冲突搁置 / **风控官否决**(分配路径,候选 rejected 且理由以"风控官"开头)/ 候选过期拦下的信号同样回填前瞻收益——被拦信号持续跑正收益说明该层过度保守,为负说明该层在创造价值,与「消融实验」页的影子组合净值互为印证;
- **排队成本**(016 迁移):候选池把买入延迟了(盘中最多一个分配间隔、隔夜到开盘),每个候选入池时记录市场价,成交时落库 入池→成交价格漂移 与 等待分钟数;「执行路径与排队时长」分桶(即时 vs 入池,≤15 分钟到 >4 小时)直接回答**延迟换来的更优资金分配是否抵得过信号变陈旧**;按入池时宏观环境的分桶则回答**避险状态下信号命中率是否真的更差**——宏观层价值的证据链。

这一层回答的是策略评估的根本问题:跑赢了,是信号好还是行情好;跑输了,是信号差还是执行差。

### 风控官(TradingAgents 式独立审批)

参考 [TradingAgents](https://arxiv.org/abs/2412.20138) 的多角色协作设计:每笔**买入**在执行前,会由一个独立于交易员的"风控官"角色做最终审批(单次 DeepSeek 调用,内含多空双方论证)。风控官看到的是交易员看不到的组合全景——各持仓/行业权重、最近 5 笔卖出的盈亏(连败应降敞口)、历史复盘教训——并给出三种裁决:**放行**、**缩仓**(scale 0~1)或**否决**,还可建议更紧的止损。裁决理由会追加到交易记录的决策依据中。审批调用失败时遵循系统的 fail-closed 约定:放弃买入,宁可错过不可冒进;卖出不经风控官(卖出本身就是降风险)。`ENABLE_RISK_OFFICER=false` 可关闭。

仓位最终缩放链:LLM 给出 fraction(**占组合总值的比例**,受可用现金约束——若按"占剩余现金比例"下单,先到的信号占大仓、后到的只剩零头,仓位大小会取决于新闻先后而非信号强弱)→ 档位/置信度/来源可信度缩放 → 连亏降仓 → 风控官 scale → 硬性风控帽(单股 ≤25%、单笔 ≤20%、最小订单 $50)。

### 组合级硬风控(代码强制,先于 LLM 风控官)

LLM 风控官不能替代硬规则——以下风控全部由服务端代码强制执行(只约束买入,所有卖出/止损/止盈/复查永远放行),013 迁移:

- **交易暂停开关(kill switch)**:管理页(`#/admin`)一键暂停开新仓,状态持久化在数据库、跨重启保留;保护性退出不受影响;
- **当日亏损熔断** `DAILY_LOSS_HALT_PERCENT`(默认 2%):当日组合亏损达到阈值即当日停止开新仓(sticky,盘中反弹不恢复,次日自动解除),基线为美东今日前最后一条净值快照;
- **最大持仓数** `MAX_OPEN_POSITIONS`(默认 10):开新仓受限,加仓不受限;
- **行业集中度上限** `MAX_SECTOR_FRACTION`(默认 35%):买后单行业市值占比超限时钳制买入金额;
- **连亏降仓** `LOSS_STREAK_COUNT` / `LOSS_STREAK_SCALE`(默认最近 3 笔全亏 → 仓位减半):连败说明当前判断系统性失准,确定性降杠杆,先于风控官生效。

### 宏观信号层与候选池资金分配(014)

个股信号之上增加了一个组合层(`ENABLE_MACRO` 默认开,需执行 014 迁移),解决三个结构性问题:先到的新闻把现金买光(路径依赖)、同一股票同时挂买单和卖单(多空冲突)、CPI/FOMC 等系统性风险不影响个股买入。

- **宏观事件流**:无个股指向的综合财经新闻走独立的宏观分析(事件类型 / risk_on·risk_off 方向 / 利率·通胀·增长含义 / 受影响行业 / 1~3 档影响力),存入 `macro_events`;经济日历数据(实际 vs 预期)自动回填数值意外幅度;
- **宏观环境(regime)**:近 72 小时宏观事件按档位 × 置信度 × 时间衰减加权聚合为连续风险分,映射到**风险偏好 / 中性 / 避险 / 宏观冲击**四态(带滞回防抖;一档高置信避险事件直接触发"宏观冲击"锁定 `MACRO_SHOCK_HOURS` 小时)。状态持久化(`macro_state`),重启延续;
- **环境联动的组合参数**(代码强制,只约束买入):每个状态对应一组 当日买入预算 / 现金保留下限 / 持仓总敞口上限 / 买入金额乘数 / 允许档位——避险时只做一档高置信信号且仓位减半,宏观冲击时暂停一切新开仓(卖出/止损永不受限);另有当日开新仓数配额 `MAX_NEW_POSITIONS_PER_DAY`(默认 3,加仓不计);
- **候选池 + 资金分配器**:利好信号过准入门槛后**不再立即交易**,而是进入 `candidate_signals` 候选池;非盘中只入池持续排序,**开盘首轮立即清算隔夜候选,盘中每 `ALLOCATION_INTERVAL_MINUTES`(默认 15)分钟一轮**——按 档位 × 置信度 × 时效衰减 × 来源可信度 × 宏观乘数 × 行业乘数 打分排序,每轮只对前 `MAX_ALLOCATIONS_PER_RUN`(默认 3)个候选发起 LLM 交易决策(成本反而低于逐条即时决策)。资金不足的高分信号标记「资金受限」留池,卖出释放现金后自动复评;超过 `CANDIDATE_MAX_AGE_HOURS`(默认 24)小时过期;
- **多空冲突消解**:同票出现反向信号时按强度比(置信度 × 档位分,1.5× 为主导阈值)裁决——利空明显更强且持仓:卖出执行、买入候选取消;势均力敌:搁置观望;利好明显更强:缩半仓放行(避险状态下一律搁置)。利空信号到达瞬间即冻结同票买入候选;
- **数据发布黑窗**:高重要性经济数据(CPI/FOMC/非农等)发布前后各 30 分钟(可配)暂停新的买入分配,避免在已知波动事件前建仓;FMP 套餐不含日历端点时自动停用黑窗,其余宏观功能不受影响;
- **前端「宏观」页**:当前环境与生效参数、经济日历与黑窗状态、宏观事件流、候选池实时预览;每笔成交记录当时的宏观环境标签。

**盘前盘后的有意不对称**:014 之前,盘前盘后的利好信号可按 aftermarket 真实价立即成交(008 的能力);引入候选池后,**利好信号一律入池**——非盘中只入池排序,到下一开盘的首轮分配才执行,而**利空仍即时卖出**(盘前盘后按 aftermarket 价,休市经开盘队列)。这是刻意的保守设计:买入是主动加风险,值得等统一的资金分配排序;卖出是降风险,一刻也不该等。代价是利好信号的执行延迟(盘中最多一个分配间隔、隔夜到开盘),这笔"排队成本"被显式度量——入池时记录市场价(`candidate_signals.entry_price`),成交时落库 入池→成交价格漂移 与 等待分钟数(`trades.pool_*`,016 迁移),「信号质量」页按执行路径与等待时长分桶对比前瞻收益,延迟换来的更优分配是否抵得过信号变陈旧,用数据回答。

**macro_shock 触发的佐证门**(016):一档高置信避险事件不再由单篇报道独自触发宏观冲击——需要同一事件归并 ≥`MACRO_SHOCK_MIN_REPORTS`(默认 2)篇报道,或 ≥2 个独立信源域名交叉佐证(复用个股侧交叉确认思路,防止一篇措辞激烈的评论文冻结全部买入 6 小时);设为 1 可恢复旧的单篇即触发。宏观事件还会记录来源可信度(009 的评分机制),regime 聚合权重 = 档位 × 置信度 × **来源分** × 时间衰减——小站标题党与路透社头条不再同权。

**确定性市场核验**(`ENABLE_MARKET_CHECK` 默认开):新闻推导的 regime 依赖 LLM 读标题,作为交叉校验,系统每 `MARKET_CHECK_POLL_MINUTES`(默认 10)分钟用 SPY 价格相对 20 日均线的趋势 + VIX 水平推出一个与新闻无关的确定性 regime;**只有两者同向 risk_on 时才放行仓位放大**(宏观乘数 >1、放宽的预算/敞口),否则按中性参数执行——避险方向永不放松,核验只钳制放大、从不加仓。VIX 报价不可用(套餐不含指数)自动退化为仅 SPY 趋势;SPY 数据不可用则核验整体停用,交易路径不受影响(fail-open)。

整层迁移容忍:未执行 014 迁移时系统自动退回纯新闻即时交易模式;`ENABLE_MACRO=false` 可整体关闭。

熔断/暂停拦下的开盘队列挂单不会被作废,保留至条件解除或超时;各项拦截都会记入运行指标的拒绝原因分布,管理页可见。

### 交易记忆与复盘(FinMem 式反思)

参考 [FinMem](https://arxiv.org/abs/2311.13743) / FinAgent 的分层记忆与反思设计:每当一笔持仓平仓(无论是利空卖出、自动止损还是止盈),DeepSeek 会复盘这笔交易——买入论点是否兑现、为何盈利/亏损——并提炼一条**可迁移的经验教训**存入 `trade_reflections` 表(006 迁移)。后续做交易决策时,系统会检索该股票最近的复盘 + 全局最重要的教训(按 importance 排序,最多 5 条)注入决策上下文,让 AI 避免在同类情形上重复犯错。复盘调用只在平仓时发生(频率低、成本可控),且异步执行绝不阻塞下单;`ENABLE_REFLECTION=false` 可关闭。

复盘按**超额收益(alpha)而非绝对盈亏(beta)评判**(016 迁移):系统会计算同持仓期的 SPY 收益(同一交易日内的持仓用 SPY 当日涨跌近似,跨日用股息调整日线收盘对收盘)一并注入复盘 prompt——大盘普涨日跑输 SPY 的盈利不算成功,跟随大盘的亏损未必是决策错误,避免把行情红利沉淀成"教训"。每日持仓复查同理,每只持仓都带同期 SPY 涨跌供模型相对大盘评判;基准取数失败时自动省略该字段,复盘/复查照常进行(fail-open)。

### 业绩指标与 SPY 基准对比

参考量化研究的标准评估方法(累计收益、夏普比率、最大回撤、与市场基准对比),仪表盘新增:

- **累计收益率**:相对初始资金的总收益,并给出相对同期 SPY 买入持有策略的**超额收益**;
- **年化夏普比率**:净值按美东**实际交易日**重采样(每日取最后一条快照,周末与交易所假日剔除,避免 0 收益伪交易日压低波动率)后,用日收益率均值/标准差 × √252 计算。账户运行不足 3 个交易日时显示「数据不足」;
- **净值图 SPY 基准线**:虚线展示「同期把初始资金全部买入 SPY」的净值走势,采用**股息调整后的总回报序列**(股息再投资,与策略净值口径一致;调整数据不可用时回退纯价格并在接口中以 `basis` 字段标记),直观回答"AI 跑没跑赢大盘"。

### LLM 交易决策可回放(018)

改 prompt 或换模型之后,收益变化来自市场随机、prompt 还是模型?没有完整的决策留痕就无法回答。018 迁移为每次**交易员决策**(`decideTrade`)连同**风控官审批**落一行 `trade_decisions` 记录(`ENABLE_DECISION_LOG` 默认开):

- **prompt 版本号**:`deepseek.js#PROMPT_VERSIONS`,修改 trader / risk-officer 的 system prompt 文本时必须 +1,样本按版本分桶;
- **完整 messages**(system+user,可原样重发给任何模型做离线重放)与 **输入快照哈希**(sha256,同输入对比不同 prompt/模型时按它对齐样本);
- **LLM 原始返回 JSON** 与 **解析钳制后的 normalized 结果**(交易员与风控官各一组);
- **仓位缩放链各步**(LLM fraction → 档位/置信/来源 → 冲突 → 连亏 → 风控官 → 最终)与**价格快照**(决策时参考价 / 成交价 / 成交时市场参考价);
- **最终结局**:executed / queued / hold / symbol_invalid / vetoed / officer_error / rejected / sell_skipped 及原因。

完整 prompt 含组合明细、历史教训等内部信息,表启用 RLS 但**不开放匿名读**(沿 `cycle_runs` 先例),只经 token 门控的 `GET /api/admin/decisions` 暴露(默认轻量列,`?full=1` 含完整 prompt/原始返回)。纯观测层 fail-open:写入失败只告警,未执行 018 迁移时自动停用。决策频率本就很低(LLM 只对头部候选发生),存储成本可忽略。

### 影子组合 / 消融实验(017)

系统叠了很多层防线(风控官、宏观过滤、候选池、来源折价、仓位缩放……),但组合盈亏回答不了"**哪一层真的提高收益,哪一层只是减少交易**"。017 迁移引入模块消融:多套**影子组合**与实盘并行记账(`ENABLE_SHADOW` 默认开),每套从同样的初始资金起步、只关闭一层防线:

| 变体 | 消融的层 | 记账方式 |
|------|---------|---------|
| `no_risk_officer` | 风控官 | 跟随实盘成交镜像;风控官**否决/缩仓**的买入按否决前方案照样执行 |
| `no_macro_filter` | 宏观层 | 跟随实盘镜像(用宏观钳制前的仓位);被 regime 过滤/宏观冲击/数据黑窗/预算钳制/开仓配额拦下的买入照样执行 |
| `immediate_trade` | 候选池 + LLM 决策链 | 独立组合:可交易利好信号到达**即按确定性仓位买入**(档位/置信度/来源缩放),利空清仓 |
| `equal_weight` | LLM 仓位分配 | 独立组合:可交易信号一律按固定比例(默认 5%)等权买入 |
| `spy_benchmark` | — | 启用时一次性全仓买入 SPY 持有 |
| `cash` | — | 纯现金 |

若「无风控官」长期跑输实盘,说明风控官的否决在创造价值;若「无宏观过滤」跑赢,说明宏观层过度拦截;「信号即时成交」对比实盘量化候选池+LLM 决策链的净价值;「信号等权」对比实盘检验 LLM 仓位是否有效。前端「消融实验」页(`/api/shadow`)展示各组合的净值曲线(窗口起点归一)、汇总对比与最近影子成交。

实现要点:影子成交与实盘共用滑点模型与基础硬帽(单笔 ≤20%、单票 ≤25%、最小订单 $50),持仓有独立的止损/止盈监控(与实盘同频,报价共享缓存);**零额外 LLM 成本**——实盘没有调用 LLM 的路径(宏观拦截重放/即时成交/等权)使用确定性仓位(`SHADOW_BASE_FRACTION`,默认 10%,再叠加档位/置信度/来源缩放)与默认止损止盈,是消融近似而非完整重放;同一变体对同一条分析最多买一次(防宏观过滤逐轮重放与留池候选后续真实成交的重复记账)。纯观测层 fail-open:任何失败只告警,绝不影响交易主链路;未执行 017 迁移时自动停用。

### 管理后台(#/admin)

访问 `https://你的域名/#/admin` 进入隐藏管理页,输入 `ADMIN_TOKEN` 登录后可:

- 查看调度运行状态(交易轮、上次运行、SSE 在线数、模型等);
- 查看**运行指标**(012 迁移,`/api/admin/metrics`):最近 20 轮的逐轮计数(新增/分析/信号/去重/挂起/挂单/成交)、耗时与完整错误,今日 LLM 调用次数/Token 用量/估算成本(按用途分桶:新闻分析/交易决策/风控审批等),行情源与模型源的错误计数,分析积压与待开盘挂单数,以及信号拒绝原因分布(去重/低置信挂起/标的核验未通过/风控官否决/漂移熔断等)——回答"系统为什么没交易";
- 查看**参数建议**(`/api/admin/advisor`):把近 30 天的信号统计反向映射成参数调整建议——低可信来源利好收益为负 → 提高 `MIN_FINAL_CONFIDENCE`;新闻稿利好命中率显著低于 50% → 加大 `PRESS_BULLISH_PENALTY` 折价;第 2 档命中率显著高于第 1 档 → 档位/LLM 分档需校准;被宏观过滤/风控官否决/资金受限/冲突搁置拦下的信号持续上涨 → 对应层过度保守(下跌则确认该层在创造价值);置信度刻度倒挂 → analyst prompt 校准。每条建议都带样本量与 95% 置信区间证据,**小样本或差异不显著时规则保持沉默**;影子组合(017)运行满 14 天后还会给出消融对照(关闭某层的变体显著跑赢/跑输实盘)。建议仅供参考,参数变更仍由人工通过环境变量执行;
- 手动触发一轮全源「抓取 → 分析 → 交易」(站内唯一的手动触发入口,公开页面不提供);
- **交易暂停开关**(013 迁移):一键暂停开新仓(做多信号与开盘队列买单全部拦截),所有卖出/止损/止盈/复查照常执行,状态持久化跨重启保留;
- **初始化所有数据**:清空全部新闻、AI 分析、事件、交易记录、持仓与净值快照,现金恢复为 `INITIAL_CAPITAL`。适用于持仓数据已脏、想从头开始的场景。操作不可恢复,页面要求输入 `RESET` 二次确认。

安全设计:管理接口(`/api/admin/*`)在服务端**强制鉴权**——未配置 `ADMIN_TOKEN` 时整组接口直接禁用(503),令牌错误返回 403;令牌比较使用 sha256 + `timingSafeEqual` 常数时间比较,且按 IP 限制鉴权失败次数(15 分钟 10 次,失败记录日志),防在线暴力破解。重置执行期间自动暂停新闻轮询与止损监控,并等待运行中的交易轮结束,绝不与交易并发删库。重置在数据库端通过 `admin_reset_data` 函数(005 迁移)单事务完成;尚未执行 005 迁移的库自动退回逐表删除。

## 技术栈

- **后端**: Node.js + Express,SSE 实时推送 + 秒级轮询调度
- **前端**: React + Vite + [Ant Design 5](https://ant.design/)(深色/浅色双主题、默认深色、Nothing 设计语言、中文界面、移动端自适应)+ Recharts 图表(构建后由后端静态托管)。字体自托管(Space Grotesk / Space Mono / Doto)。配色遵循美股惯例:绿涨红跌
- **数据**: [FMP API](https://site.financialmodelingprep.com/developer/docs)(新闻 + 实时报价)、Yahoo Finance RSS(补充新闻源)
- **AI**: [DeepSeek API](https://api-docs.deepseek.com/)(新闻分析 + 交易决策,模型可配置)
- **存储**: Supabase (PostgreSQL)
- **部署**: Render(`render.yaml` Blueprint)
- **测试**: `node:test` 单元测试(交易日历、滑点模型、可信度评分、仓位缩放、准入门槛、前瞻收益等纯函数),GitHub Actions CI(`npm test` + 前端构建)

## 部署步骤

### 1. 初始化 Supabase

1. 在 [supabase.com](https://supabase.com) 创建项目;
2. 打开 **SQL Editor**,执行仓库中的 [`supabase/schema.sql`](supabase/schema.sql);**已有部署升级时**,改为执行 `supabase/migrations/` 下的增量脚本(如 [`002_stops_and_stats.sql`](supabase/migrations/002_stops_and_stats.sql)、[`003_news_events.sql`](supabase/migrations/003_news_events.sql)、[`004_atomic_trade.sql`](supabase/migrations/004_atomic_trade.sql)、[`005_admin_reset.sql`](supabase/migrations/005_admin_reset.sql)、[`006_trade_reflections.sql`](supabase/migrations/006_trade_reflections.sql)、[`007_position_management.sql`](supabase/migrations/007_position_management.sql)、[`008_fill_realism.sql`](supabase/migrations/008_fill_realism.sql)、[`009_source_credibility.sql`](supabase/migrations/009_source_credibility.sql)、[`010_open_queue.sql`](supabase/migrations/010_open_queue.sql)、[`011_signal_forward_returns.sql`](supabase/migrations/011_signal_forward_returns.sql)、[`012_observability.sql`](supabase/migrations/012_observability.sql)、[`013_risk_controls.sql`](supabase/migrations/013_risk_controls.sql)、[`014_macro_portfolio.sql`](supabase/migrations/014_macro_portfolio.sql)、[`015_macro_event_dedup.sql`](supabase/migrations/015_macro_event_dedup.sql)、[`016_execution_quality_and_market_check.sql`](supabase/migrations/016_execution_quality_and_market_check.sql)、[`017_shadow_portfolios.sql`](supabase/migrations/017_shadow_portfolios.sql)、[`018_decision_replay.sql`](supabase/migrations/018_decision_replay.sql)、[`019_shadow_dedup_unique.sql`](supabase/migrations/019_shadow_dedup_unique.sql));
3. 在 **Project Settings → API** 记下 `Project URL` 和 `service_role` key。

### 2. 部署到 Render

1. 将本仓库推送到你的 GitHub;
2. 在 [Render](https://render.com) 控制台选择 **New + → Blueprint**,关联本仓库(自动读取 `render.yaml`);
3. 在服务的 **Environment** 中填入:
   - `FMP_API_KEY` — FMP Ultimate 订阅的 API Key
   - `DEEPSEEK_API_KEY` — DeepSeek 平台的 API Key
   - `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`
4. 部署完成后访问服务 URL 即可。

> ⚠️ **注意**:Render Free 计划的服务无流量时会休眠,定时抓取/交易会停摆,建议使用 Starter 及以上计划。若坚持用 Free 计划,可用外部定时服务(如 cron-job.org)定时请求一次 `POST https://你的域名/api/run-cycle` 来代替内置定时器(设置了 `ADMIN_TOKEN` 时需携带 `x-admin-token` 请求头)。

### 实时性说明(SSE 秒级推送)

- 网页通过 **Server-Sent Events**(`/api/stream`)与服务端保持长连接,新闻入库、分析完成、成交、净值快照一发生就**秒级推送**到浏览器,无需刷新
- 有访客在线时,服务端每 **5 秒**推送一次持仓实时报价与组合估值(无人在线自动暂停,节省 API 配额)
- 个股新闻每 **20 秒**轮询一次 FMP;综合新闻/公告/Yahoo RSS 每约 5 分钟带一轮(同一条新闻只分析一次,DeepSeek 成本可控)
- SSE 断线时前端自动降级为 60 秒轮询,并在重连后恢复实时(页面右上角有实时连接指示灯)

### 3. 本地运行

```bash
cp .env.example .env       # 填入各项 Key
npm install
npm run build              # 构建前端
npm start                  # http://localhost:3000
```

前端开发模式(热更新):

```bash
npm start                  # 终端 1:启动后端 :3000
cd web && npm run dev      # 终端 2:启动 Vite :5173(已配置 /api 代理)
```

## 配置项

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `FMP_API_KEY` | — | FMP API Key(必填) |
| `DEEPSEEK_API_KEY` | — | DeepSeek API Key(必填) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | — | Supabase 连接信息(必填) |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型 ID,按 DeepSeek 官方文档可换成更新的模型 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek 接口地址(代理/兼容网关时覆盖) |
| `DEEPSEEK_COST_PER_1M_INPUT` / `DEEPSEEK_COST_PER_1M_OUTPUT` | `0.56` / `1.68` | LLM 成本估算单价(美元/百万 token),仅用于管理页运行指标的成本展示;默认为 deepseek-chat 牌价的缓存未命中口径(估算上限) |
| `NEWS_POLL_SECONDS` | `20` | 个股新闻轮询间隔(秒),已去重的新闻不会重复分析 |
| `QUOTE_PUSH_SECONDS` | `5` | 实时报价 SSE 推送间隔(秒),仅有访客在线时拉取 |
| `SNAPSHOT_SECONDS` | `60` | 净值快照间隔(秒),决定盈亏折线图粒度;休市时段自动降频到每 30 分钟一条 |
| `RISK_CHECK_SECONDS` | `30` | 止损/止盈监控间隔(秒),休市时段自动跳过 |
| `MAX_ANALYZE_PER_CYCLE` | `8` | 每轮最多分析的新闻条数(控制 DeepSeek 成本);超出的进入积压队列,后续轮次继续消化(仅保留近 24 小时) |
| `SIGNAL_STATS_MAX_ROWS` | `20000` | 信号质量页/参数建议器单次加载的最大信号样本数(纯观测);偏低时较早已成熟(有 1/5 个交易日前瞻收益)的信号会被新信号挤出窗口,1d/5d 统计逐渐消失 |
| `INITIAL_CAPITAL` | `100000` | 模拟账户初始资金(美元) |
| `TRADE_TIER_THRESHOLD` | `2` | 触发交易的最低档位 |
| `EVENT_DEDUP_HOURS` | `72` | 事件去重窗口(小时),同一事件的多渠道报道只触发一次交易 |
| `EVENT_NEAR_DUP_SIMILARITY` | `0.8` | 近似重复判定的相似度阈值(0~1),标题/事件归纳达标即判为同一事件,作为 LLM 事件归并的确定性兜底 |
| `MIN_FINAL_CONFIDENCE` | `0.35` | 综合置信度门槛(来源可信度×置信度×时效×档位),低于门槛的信号挂起等待独立信源交叉确认;设 0 关闭,需执行 009 迁移 |
| `TRADE_COOLDOWN_MINUTES` | `30` | 同一股票同方向新闻交易的冷却期(分钟),事件去重的兜底防线 |
| `WATCHLIST` | 七巨头 | Yahoo RSS 抓取的关注列表,持仓自动加入 |
| `ENABLE_YAHOO` | `true` | 是否启用 Yahoo Finance RSS 补充源 |
| `ENABLE_REFLECTION` | `true` | 平仓后是否复盘并沉淀经验教训(注入后续决策),需执行 006 迁移 |
| `ENABLE_TRAILING_STOP` | `true` | 移动止损:创新高后止损价跟随上抬,需执行 007 迁移 |
| `ENABLE_POSITION_REVIEW` | `true` | 每日持仓复查:论点失效的持仓主动卖出/收紧止损 |
| `POSITION_REVIEW_HOUR` | `14` | 持仓复查触发时间(美东 24 小时制,盘中) |
| `ENABLE_RISK_OFFICER` | `true` | 风控官:买入前组合级复核(放行/缩仓/否决),失败放弃买入 |
| `ENABLE_SLIPPAGE` | `true` | 模拟成交滑点:按市值/时段/波动/订单冲击对成交价施加不利偏移 |
| `SLIPPAGE_MAX_BPS` | `150` | 单笔滑点上限(基点) |
| `COMMISSION_BPS` | `0` | 佣金(基点,折算进成交价) |
| `BUY_PRICE_DRIFT_ABORT_PERCENT` | `5` | 买入漂移熔断:下单时价格相对决策时偏移超过该百分比即放弃 |
| `OPENING_WINDOW_MINUTES` / `OPENING_SLIPPAGE_MULT` | `15` / `2` | 开盘窗口滑点放大:开盘后前 N 分钟点差最宽,滑点额外乘该系数(窗口设 0 关闭) |
| `MIN_MARKET_CAP` | `300000000` | 标的准入:最小市值(美元),只约束买入;设 0 关闭 |
| `MIN_PRICE` | `2` | 标的准入:最低股价(美元);设 0 关闭 |
| `MIN_AVG_DOLLAR_VOLUME` | `5000000` | 标的准入:最低日均美元成交额(日均成交量×现价);设 0 关闭 |
| `ALLOWED_EXCHANGES` | `NASDAQ,NYSE,AMEX` | 标的准入:交易所白名单(短代码,大小写不敏感),自动屏蔽 OTC/粉单;显式设空关闭。ETF/基金始终拦截 |
| `DAILY_LOSS_HALT_PERCENT` | `2` | 硬风控:当日组合亏损达到该百分比即当日停止开新仓(sticky,次日恢复);设 0 关闭 |
| `MAX_OPEN_POSITIONS` | `10` | 硬风控:最大同时持仓数(加仓不受限);设 0 关闭 |
| `MAX_SECTOR_FRACTION` | `0.35` | 硬风控:单行业市值占组合总值上限(超出部分钳制买入金额);设 0 关闭 |
| `LOSS_STREAK_COUNT` / `LOSS_STREAK_SCALE` | `3` / `0.5` | 硬风控:最近 N 笔卖出全亏时买入比例乘以该系数;`LOSS_STREAK_SCALE=1` 关闭 |
| `PRESS_BULLISH_PENALTY` | `0.75` | 公司公告类来源的利好信号在置信度门槛上的折价(1=不折价) |
| `PENDING_ORDER_MAX_AGE_HOURS` | `96` | 开盘队列挂单的最长等待时长(小时),超时作废,需执行 010 迁移 |
| `ENABLE_MACRO` | `true` | 宏观信号层 + 候选池 + 资金分配器总开关(需执行 014 迁移);关闭后退回纯新闻即时模式 |
| `CALENDAR_POLL_MINUTES` | `60` | 经济日历刷新间隔(分钟);数据套餐不含该端点时自动停用黑窗,其余宏观功能不受影响 |
| `MACRO_EVENT_VALIDITY_HOURS` | `72` | 宏观事件有效窗口(小时):聚合市场环境时只看窗口内事件 |
| `MACRO_SHOCK_HOURS` | `6` | 宏观冲击锁定时长(小时):一档高置信避险事件触发后暂停一切新开仓 |
| `MACRO_SHOCK_MIN_REPORTS` | `2` | 宏观冲击佐证门:触发需同一事件归并 ≥N 篇报道或 ≥N 个独立信源域名(设 1 恢复单篇即触发),需执行 016 迁移 |
| `ENABLE_MARKET_CHECK` | `true` | 确定性市场核验:SPY 20 日均线趋势 + VIX 与新闻 regime 交叉校验,只有同向 risk_on 才放行仓位放大;VIX 不可用退化为仅 SPY,SPY 不可用自动停用 |
| `MARKET_CHECK_POLL_MINUTES` | `10` | 市场核验刷新间隔(分钟) |
| `BLACKOUT_BEFORE_MINUTES` / `BLACKOUT_AFTER_MINUTES` | `30` / `30` | 重大数据发布黑窗:发布前/后 N 分钟不执行买入分配(卖出/止损不受影响);设 0 关闭 |
| `ALLOCATION_INTERVAL_MINUTES` | `15` | 资金分配器盘中节奏:每 N 分钟一轮(开盘首轮立即清算隔夜候选) |
| `MAX_ALLOCATIONS_PER_RUN` | `3` | 每轮分配最多执行的买入候选数(LLM 决策只对头部候选发生) |
| `CANDIDATE_MAX_AGE_HOURS` | `24` | 候选有效期(小时),超龄未分配自动过期 |
| `MAX_NEW_POSITIONS_PER_DAY` | `3` | 当日最多开新仓数(加仓不计);设 0 关闭 |
| `CONFLICT_WINDOW_MINUTES` | `120` | 同票多空冲突判定窗口(分钟) |
| `ENABLE_DECISION_LOG` | `true` | LLM 交易决策可回放:每次交易员决策连同风控官审批落库完整 prompt/原始返回(需执行 018 迁移,缺表自动停用) |
| `ENABLE_SHADOW` | `true` | 影子组合 / 消融实验:多套虚拟组合与实盘并行记账,每套关闭一层防线(需执行 017 迁移,缺表自动停用) |
| `SHADOW_BASE_FRACTION` | `0.1` | 影子组合中无 LLM 决策路径(宏观拦截重放/即时成交)的确定性基础仓位(占组合总值,再叠加档位/置信度/来源缩放) |
| `SHADOW_EQUAL_WEIGHT_FRACTION` | `0.05` | 等权变体的固定买入比例(占组合总值) |
| `ADMIN_TOKEN` | 空 | 设置后手动触发接口需要鉴权;同时是管理后台(`#/admin`)的登录口令,未设置时管理接口整组禁用 |
| `TRUST_PROXY` | `1` | 信任的反向代理跳数(Render 单层代理为 1);**无代理直连部署须设 `0`**,否则伪造 `X-Forwarded-For` 可绕过按 IP 的鉴权失败限流 |
| `PORT` | `3000` | 服务监听端口 |

## API 一览

| 接口 | 说明 |
|------|------|
| `GET /api/portfolio` | 组合概览(现金、总值、盈亏、持仓+实时报价) |
| `GET /api/snapshots` | 净值快照序列(盈亏折线图数据) |
| `GET /api/trades` | 交易记录(含买卖原因、关联新闻) |
| `GET /api/news` | 新闻流(含 DeepSeek 分析结果) |
| `GET /api/stream` | SSE 实时推送流(news / analysis / trade / portfolio / snapshot / cycle / reset / macro) |
| `GET /api/stats` | 组合统计(今日盈亏、已实现盈亏、胜率、最大回撤) |
| `GET /api/performance` | 业绩指标(夏普比率、累计收益率、SPY 基准对比与超额收益) |
| `GET /api/signal-stats` | 信号质量统计(命中率含 Wilson 95% 区间/平均收益/IC,按档位/来源/置信度/拦截层分桶;`?days=` 限定窗口) |
| `GET /api/shadow` | 影子组合 / 消融实验(各变体估值、净值序列、最近影子成交、实盘对照;`?hours=` 限定窗口) |
| `GET /api/macro` | 宏观环境(当前 regime 与生效参数、宏观事件、经济日历/黑窗、候选池概览) |
| `GET /api/pool` | 买入候选池预览(待分配/受限/搁置候选与状态) |
| `GET /api/pending-orders` | 等待开盘成交的挂单(休市时段产生的信号) |
| `GET /api/symbol/:symbol` | 单只股票详情(报价、持仓、分析、交易历史) |
| `GET /api/status` | 调度器状态(公开版,不含模型等内部配置) |
| `POST /api/run-cycle` | 手动触发一轮抓取/分析/交易(未设 `ADMIN_TOKEN` 时全局 120 秒冷却,防滥用) |
| `GET /api/health` | 健康检查 |
| `GET /api/admin/verify` | 管理:校验令牌(以下均需 `x-admin-token` 请求头) |
| `GET /api/admin/status` | 管理:调度与运行状态 |
| `GET /api/admin/metrics` | 管理:运行指标(最近运行、今日 LLM 用量/成本、错误计数、积压/挂单、拒绝原因分布) |
| `GET /api/admin/decisions` | 管理:LLM 交易决策回放记录(`?full=1` 含完整 prompt/原始返回) |
| `GET /api/admin/advisor` | 管理:参数建议(信号统计 + 影子组合对照推导的调参建议,带样本量/置信区间证据) |
| `POST /api/admin/trading-halt` | 管理:交易暂停开关(body `{"halted":true|false}`,只停开新仓,卖出不受影响) |
| `POST /api/admin/run-cycle` | 管理:手动触发一轮(带鉴权,无冷却) |
| `POST /api/admin/reset` | 管理:全量数据初始化(body 需 `{"confirm":"RESET"}`) |

## 常见问题

**部署后日志出现 `Node.js 20 detected without native WebSocket support` 警告?**
这是 `@supabase/supabase-js` 的 Realtime 模块在 Node < 22 下的提示。本项目不使用 Realtime 功能,该警告无害;但建议使用 Node 22+(`render.yaml` 已配置 `NODE_VERSION=22`)。如果你的 Render 服务是在旧配置下创建的,请到服务的 **Environment** 页将 `NODE_VERSION` 改为 `22` 并手动重新部署即可消除警告。

## 设计参考

系统的核心机制参考了以下研究与开源项目:

- [Can ChatGPT Forecast Stock Price Movements?](https://arxiv.org/abs/2304.07619)(Lopez-Lira & Tang)— LLM 新闻信号的有效性与信号强度-仓位映射
- [TradingAgents: Multi-Agents LLM Financial Trading Framework](https://arxiv.org/abs/2412.20138) — 多角色协作与独立风控审批
- [FinMem: A Performance-Enhanced LLM Trading Agent with Layered Memory](https://arxiv.org/abs/2311.13743) — 交易记忆与反思机制
- [Large Language Model Agent in Financial Trading: A Survey](https://arxiv.org/abs/2408.06361) — 评估指标与架构综述
- [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) — 多角色 AI 投资组合的开源实践

## 免责声明

本项目仅为模拟交易与技术演示,所有"买入/卖出"均为虚拟操作,不构成任何投资建议。
