# AI 新闻交易员 — 基于新闻的美股模拟交易网站

自动抓取财经新闻 → DeepSeek 判断利好/利空(四档分级)→ 基于信号自动模拟买卖美股 → 网页实时展示盈亏曲线、持仓、交易记录与买卖原因。无需登录,所有人公开可见。

## 工作流程

```
┌─────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ 新闻源       │ → │ DeepSeek 分析 │ → │ 模拟交易引擎  │ → │ 网页展示      │
│ FMP 个股新闻 │   │ 利好/利空     │   │ DeepSeek 决策 │   │ 盈亏折线图    │
│ FMP 综合新闻 │   │ 四档分级      │   │ FMP 实时报价  │   │ 持仓/交易记录 │
│ FMP 公司公告 │   │ 置信度+理由   │   │ 风控约束      │   │ 买卖原因      │
│ Yahoo RSS   │   └──────────────┘   └──────────────┘   └──────────────┘
└─────────────┘          ↓                  ↓                  ↑
                 ┌────────────────── Supabase 数据库 ──────────────────┐
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
2. 可交易信号先在 `news_events` 表内做事件归并:DeepSeek 对比该股票近 `EVENT_DEDUP_HOURS`(默认 72)小时内的已记录事件,判断是否为重复报道/跟进报道;
3. 重复报道只累计报道数,不再触发交易;只有真正的新事件才放行;
4. 新事件放行前再过一道同向交易冷却期(`TRADE_COOLDOWN_MINUTES`,默认 30 分钟),作为 LLM 误判的兜底;去重检查全部不可用时保守跳过,宁可错过也不重复下单。

### 止损 / 止盈 / 移动止损

每次买入时,DeepSeek 会根据新闻强度与股票波动性同时设定**止损价**(成本价下方 3%~15%)和**止盈价**(上方 5%~30%),存储在持仓上。服务端每 `RISK_CHECK_SECONDS`(默认 30 秒)监控一次持仓价格(含盘前盘后),跌破止损价或触及止盈价即自动全仓卖出,交易记录中会标注「自动止损 / 自动止盈」及详细原因。加仓时按新的平均成本重新设定。在本功能上线前已存在的持仓没有止损价,可在 Supabase 中手动 `update positions set stop_loss=..., take_profit=...` 补设。

**移动止损**(007 迁移,`ENABLE_TRAILING_STOP` 默认开):股价创出建仓后新高时,止损价按买入时设定的止损距离跟随上抬(峰值价 × (1 − 原止损距离)),只升不降、止盈价不动,浮盈越大保护越紧。

### 仓位缩放与每日持仓复查

- **按信号质量缩放仓位**(参考 [Lopez-Lira & Tang](https://arxiv.org/abs/2304.07619):信号强度应映射到仓位):在 LLM 给出的买入比例之上,按档位(一档 ×1.0、二档 ×0.7)与置信度(0.5→×0.5,1.0→×1.0)叠加缩放,最终仍受硬性风控帽(单股 ≤25%、单笔 ≤20%)约束;
- **每日持仓复查**(`ENABLE_POSITION_REVIEW` 默认开):新闻驱动的买入论点有时效性。每个交易日美东 `POSITION_REVIEW_HOUR`(默认 14)点后,DeepSeek 用**一次调用**整体评估全部持仓——论点已失效的主动卖出(交易标注「持仓复查」)、浮盈较大的收紧止损、健康的维持持有,防止过期论点的持仓长期滞留。

### 盘前盘后价格与交易日历

非盘中时段,系统通过 FMP 的 aftermarket-trade 接口获取盘前(美东 4:00–9:30)/盘后(16:00–20:00)最新成交价,用于估值、模拟成交和止损监控;页面持仓表会显示「盘前 / 盘后」徽章及相对收盘价的涨跌幅。若订阅不含该端点,自动退回收盘价。

市场时段判断内置 NYSE 交易日历(按规则计算,不会过期):全天休市假日(含耶稣受难日等浮动假日与固定假日的周末观察日)直接按休市处理,7/3、感恩节次日、平安夜等半日市 13:00 提前收盘;止损监控、快照降频、报价推送在假日自动停止,夏普等日度指标也只统计实际交易日。

### 模拟成交真实化(滑点 / 点差 / 漂移熔断)

新闻驱动策略的真实瓶颈是执行成本:消息后往往买在 spike、盘前盘后点差大、小盘股流动性差。为避免系统性高估收益,模拟成交做了三层处理:

- **下单时重取报价**:LLM 决策可能耗时数十秒甚至更久,买卖都在下单瞬间重新拉取最新价格成交,绝不按"消息发布瞬间的价格"成交;
- **漂移熔断**:下单时最新价相对决策时价格偏移超过 `BUY_PRICE_DRIFT_ABORT_PERCENT`(默认 5%)即放弃买入——上漂是追高,下漂说明行情已反转;
- **滑点模型**(`ENABLE_SLIPPAGE` 默认开):成交价在最新市场价上施加不利偏移(买更贵、卖更便宜),滑点 = 按市值分档的半点差(超大盘 1bp ~ 微盘 30bp)× 时段乘数(盘前盘后 ×3)× 当日波动乘数 + 订单冲击(按占日均美元成交额比例)+ 可选佣金(`COMMISSION_BPS`),单笔封顶 `SLIPPAGE_MAX_BPS`(默认 150bp)。每笔交易的市场参考价与实际滑点记录在 `trades.quote_price / slippage_bps`(008 迁移)。

### 风控官(TradingAgents 式独立审批)

参考 [TradingAgents](https://arxiv.org/abs/2412.20138) 的多角色协作设计:每笔**买入**在执行前,会由一个独立于交易员的"风控官"角色做最终审批(单次 DeepSeek 调用,内含多空双方论证)。风控官看到的是交易员看不到的组合全景——各持仓/行业权重、最近 5 笔卖出的盈亏(连败应降敞口)、历史复盘教训——并给出三种裁决:**放行**、**缩仓**(scale 0~1)或**否决**,还可建议更紧的止损。裁决理由会追加到交易记录的决策依据中。审批调用失败时遵循系统的 fail-closed 约定:放弃买入,宁可错过不可冒进;卖出不经风控官(卖出本身就是降风险)。`ENABLE_RISK_OFFICER=false` 可关闭。

仓位最终缩放链:LLM 给出 fraction → 档位/置信度缩放 → 风控官 scale → 硬性风控帽(单股 ≤25%、单笔 ≤20%、最小订单 $50)。

### 交易记忆与复盘(FinMem 式反思)

参考 [FinMem](https://arxiv.org/abs/2311.13743) / FinAgent 的分层记忆与反思设计:每当一笔持仓平仓(无论是利空卖出、自动止损还是止盈),DeepSeek 会复盘这笔交易——买入论点是否兑现、为何盈利/亏损——并提炼一条**可迁移的经验教训**存入 `trade_reflections` 表(006 迁移)。后续做交易决策时,系统会检索该股票最近的复盘 + 全局最重要的教训(按 importance 排序,最多 5 条)注入决策上下文,让 AI 避免在同类情形上重复犯错。复盘调用只在平仓时发生(频率低、成本可控),且异步执行绝不阻塞下单;`ENABLE_REFLECTION=false` 可关闭。

### 业绩指标与 SPY 基准对比

参考量化研究的标准评估方法(累计收益、夏普比率、最大回撤、与市场基准对比),仪表盘新增:

- **累计收益率**:相对初始资金的总收益,并给出相对同期 SPY 买入持有策略的**超额收益**;
- **年化夏普比率**:净值按美东**实际交易日**重采样(每日取最后一条快照,周末与交易所假日剔除,避免 0 收益伪交易日压低波动率)后,用日收益率均值/标准差 × √252 计算。账户运行不足 3 个交易日时显示「数据不足」;
- **净值图 SPY 基准线**:虚线展示「同期把初始资金全部买入 SPY」的净值走势,采用**股息调整后的总回报序列**(股息再投资,与策略净值口径一致;调整数据不可用时回退纯价格并在接口中以 `basis` 字段标记),直观回答"AI 跑没跑赢大盘"。

### 管理后台(#/admin)

访问 `https://你的域名/#/admin` 进入隐藏管理页,输入 `ADMIN_TOKEN` 登录后可:

- 查看调度运行状态(交易轮、上次运行、SSE 在线数、模型等);
- 手动触发一轮全源「抓取 → 分析 → 交易」(站内唯一的手动触发入口,公开页面不提供);
- **初始化所有数据**:清空全部新闻、AI 分析、事件、交易记录、持仓与净值快照,现金恢复为 `INITIAL_CAPITAL`。适用于持仓数据已脏、想从头开始的场景。操作不可恢复,页面要求输入 `RESET` 二次确认。

安全设计:管理接口(`/api/admin/*`)在服务端**强制鉴权**——未配置 `ADMIN_TOKEN` 时整组接口直接禁用(503),令牌错误返回 403;令牌比较使用 sha256 + `timingSafeEqual` 常数时间比较,且按 IP 限制鉴权失败次数(15 分钟 10 次,失败记录日志),防在线暴力破解。重置执行期间自动暂停新闻轮询与止损监控,并等待运行中的交易轮结束,绝不与交易并发删库。重置在数据库端通过 `admin_reset_data` 函数(005 迁移)单事务完成;尚未执行 005 迁移的库自动退回逐表删除。

## 技术栈

- **后端**: Node.js + Express,SSE 实时推送 + 秒级轮询调度
- **前端**: React + Vite + [Ant Design 5](https://ant.design/)(浅色主题、中文界面、移动端自适应)+ Recharts 图表(构建后由后端静态托管)。配色遵循美股惯例:绿涨红跌
- **数据**: [FMP API](https://site.financialmodelingprep.com/developer/docs)(新闻 + 实时报价)、Yahoo Finance RSS(补充新闻源)
- **AI**: [DeepSeek API](https://api-docs.deepseek.com/)(新闻分析 + 交易决策,模型可配置)
- **存储**: Supabase (PostgreSQL)
- **部署**: Render(`render.yaml` Blueprint)

## 部署步骤

### 1. 初始化 Supabase

1. 在 [supabase.com](https://supabase.com) 创建项目;
2. 打开 **SQL Editor**,执行仓库中的 [`supabase/schema.sql`](supabase/schema.sql);**已有部署升级时**,改为执行 `supabase/migrations/` 下的增量脚本(如 [`002_stops_and_stats.sql`](supabase/migrations/002_stops_and_stats.sql)、[`003_news_events.sql`](supabase/migrations/003_news_events.sql)、[`004_atomic_trade.sql`](supabase/migrations/004_atomic_trade.sql)、[`005_admin_reset.sql`](supabase/migrations/005_admin_reset.sql)、[`006_trade_reflections.sql`](supabase/migrations/006_trade_reflections.sql)、[`007_position_management.sql`](supabase/migrations/007_position_management.sql)、[`008_fill_realism.sql`](supabase/migrations/008_fill_realism.sql));
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
| `NEWS_POLL_SECONDS` | `20` | 个股新闻轮询间隔(秒),已去重的新闻不会重复分析 |
| `QUOTE_PUSH_SECONDS` | `5` | 实时报价 SSE 推送间隔(秒),仅有访客在线时拉取 |
| `SNAPSHOT_SECONDS` | `60` | 净值快照间隔(秒),决定盈亏折线图粒度;休市时段自动降频到每 30 分钟一条 |
| `RISK_CHECK_SECONDS` | `30` | 止损/止盈监控间隔(秒),休市时段自动跳过 |
| `MAX_ANALYZE_PER_CYCLE` | `8` | 每轮最多分析的新闻条数(控制 DeepSeek 成本);超出的进入积压队列,后续轮次继续消化(仅保留近 24 小时) |
| `INITIAL_CAPITAL` | `100000` | 模拟账户初始资金(美元) |
| `TRADE_TIER_THRESHOLD` | `2` | 触发交易的最低档位 |
| `EVENT_DEDUP_HOURS` | `72` | 事件去重窗口(小时),同一事件的多渠道报道只触发一次交易 |
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
| `ADMIN_TOKEN` | 空 | 设置后手动触发接口需要鉴权;同时是管理后台(`#/admin`)的登录口令,未设置时管理接口整组禁用 |

## API 一览

| 接口 | 说明 |
|------|------|
| `GET /api/portfolio` | 组合概览(现金、总值、盈亏、持仓+实时报价) |
| `GET /api/snapshots` | 净值快照序列(盈亏折线图数据) |
| `GET /api/trades` | 交易记录(含买卖原因、关联新闻) |
| `GET /api/news` | 新闻流(含 DeepSeek 分析结果) |
| `GET /api/stream` | SSE 实时推送流(news / analysis / trade / portfolio / snapshot / cycle) |
| `GET /api/stats` | 组合统计(今日盈亏、已实现盈亏、胜率、最大回撤) |
| `GET /api/performance` | 业绩指标(夏普比率、累计收益率、SPY 基准对比与超额收益) |
| `GET /api/symbol/:symbol` | 单只股票详情(报价、持仓、分析、交易历史) |
| `GET /api/status` | 调度器状态(公开版,不含模型等内部配置) |
| `POST /api/run-cycle` | 手动触发一轮抓取/分析/交易(未设 `ADMIN_TOKEN` 时全局 120 秒冷却,防滥用) |
| `GET /api/health` | 健康检查 |
| `GET /api/admin/verify` | 管理:校验令牌(以下均需 `x-admin-token` 请求头) |
| `GET /api/admin/status` | 管理:调度与运行状态 |
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
