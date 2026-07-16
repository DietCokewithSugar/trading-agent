# 系统架构全景(逐文件说明)

> AI 新闻交易员 —— 新闻驱动的美股模拟交易系统。本文档覆盖仓库中每一个源码文件的职责与核心逻辑,
> 与代码同步维护;概要版见 `CLAUDE.md`(面向 AI 协作)与 `README.md`(面向部署使用)。
> 更新代码时若改变了某个文件的职责边界,请同步更新本文档对应条目。

## 1. 系统总览

**单 Node 进程**:Express 同时提供 `/api/*` 接口与 `web/dist` 静态前端;`server/scheduler.js`
在同一进程内跑十四个 `setInterval` 后台循环(新闻轮询/报价推送/快照/风控/复查/开盘队列/
前瞻收益回填/标的名录/停牌监控/经济日历/宏观重算/资金分配/市场核验/影子止损)。没有独立队列或 worker。

```
FMP API ──┐
Yahoo RSS ┼→ 新闻抓取 → LLM 分析(DeepSeek)→ 事件去重 ┼─→ SSE 推送 → React 前端(web/dist)
SEC EDGAR ┤                                        ├─→ Supabase Postgres(唯一持久层)
经济日历 ──┘        ↓                               └─→ 运行指标/决策回放(管理面)
              个股信号 ─→ 利好:候选池 → 资金分配器 → 交易员 LLM → 风控官 LLM → 硬风控 → 模拟成交
                    └──→ 利空:确定性立即清仓(不经 LLM)
              宏观信号 ─→ 宏观事件 → regime 聚合(纯代码)→ 组合级预算/敞口钳制
   并行:影子组合(消融实验) · 信号前瞻收益(评估层) · 参数建议器 · 每日复查 · 复盘记忆
```

**交易时段**:美东 04:00–20:00(盘前 04:00–09:30 / 盘中 09:30–16:00 / 盘后 16:00–20:00,
半日市 13:00 收盘),由 `fmp.js#getMarketSession` 按 America/New_York 墙钟计算,EDT/EST 自动切换。
休市(夜间/周末/假日)期间:利好信号只入池、卖出信号挂开盘队列、影子信号顺延排队。

**核心风控参数**(默认值,均可 env 覆盖):止盈/止损固定为买入均价 ±2%;持仓最长 48 小时
(同票新利好刷新时钟并把止盈线上抬 1 个百分点);最大持仓 15 只;同票新利空不经 LLM 立即全仓清仓;
容量/现金不足时"止盈腾位"(卖出最接近止盈价的盈利持仓给新候选让位)。

**两条元约定**贯穿全部代码:
- **fail-closed(交易主链路)**:去重失败跳过交易、风控官调用失败放弃买入、档案缺失不准入——宁可错过,不可冒进。
- **fail-open(观测层)**:指标/回放/影子/评估/宏观增强功能失败只告警,绝不打断交易;所有 schema 变更做“迁移容忍”(缺表/缺列自动停用对应功能或 strip-and-retry)。

## 2. 根目录

| 文件 | 说明 |
|---|---|
| `package.json` | 根服务端依赖(express/@supabase/supabase-js/express-rate-limit);`npm start` 起服务,`npm test` 跑 node:test,`npm run build` 构建前端 |
| `.env.example` | 全部环境变量样例与中文注释(必填 4 个 key + 数十个可选调参) |
| `render.yaml` | Render Blueprint:构建/启动命令、健康检查 `/api/health`、全量 env 默认值 |
| `CLAUDE.md` | 面向 AI 协作的架构摘要与约定(本文档的浓缩版) |
| `README.md` | 面向人的完整功能说明、部署步骤、env 表、API 表 |
| `AGENTS.md` | Cursor Cloud 开发环境说明 |
| `.claude/skills/` | 项目级 Agent Skills:frontend-design + superpowers 精选(TDD/系统化调试/完成前验证/代码评审/头脑风暴/写计划/执行计划),`skills-lock.json` 锁定来源版本 |
| `.github/workflows/ci.yml` | CI:每次 push/PR 跑 `npm test` + 前端构建 |

## 3. 服务端入口与路由(`server/`)

### `server/index.js`
进程入口:装配 Express(`trust proxy` 按 `TRUST_PROXY`)、挂载 `/api`(api.js)与 `/api/admin`
(admin.js)路由、托管 `web/dist` 静态文件(SPA 回退到 index.html)、`assertConfig()` 检查
必填 env——缺失时服务照常启动(接口+静态页可用)但不启动调度器。

### `server/config.js`
唯一配置来源:全部 env 解析与默认值(`num`/`num0` 区分"0 视为非法"与"0 合法");
代码常量组(`tierSizeMultipliers`、`macroRegimeParams` 各 regime 的现金保留/预算/敞口/乘数/允许档位、
`marketCheckParams`、`shadowDefaultStops`)。固定止盈止损 `stopLossPercent`/`takeProfitPercent`
提升为模块级常量供 `shadowDefaultStops` 派生,保证实盘与影子同一离场规则。

### `server/db.js`
Supabase 客户端单例(service_role key,绕过 RLS);未配置时抛中文错误由各调用方降级。
前端永远不直连 Supabase,一切经 `/api/*`。

### `server/scheduler.js`
十四个循环的装配点,全部经 `singleton.js#makeSingleton` 包装(防重入 + 卡死告警)。
循环与节奏:

| 循环 | 间隔 | 时段条件 |
|---|---|---|
| 新闻轮询 `runCycle` | `NEWS_POLL_SECONDS`(20s,≥5s) | 全天候(约每 5 分钟一轮全源 fullFetch) |
| 报价/估值推送 | `QUOTE_PUSH_SECONDS`(5s) | 仅当有 SSE 客户端在线;同 tick 附带 `quotesPush.js#pushLiveQuotes` 广播 `quotes` 事件(持仓+候选池 top 符号的紧凑报价映射,休市经 5 分钟缓存容忍度降频) |
| 净值快照 | `SNAPSHOT_SECONDS`(60s) | 休市降频至 30 分钟一次 |
| 风控检查 `checkStops` | `RISK_CHECK_SECONDS`(30s) | 休市跳过(盘前/盘后照常) |
| 影子止损 `checkShadowStops` | 同上 | 同上(并在首个可交易 tick 清算顺延信号) |
| 每日持仓复查 | 10 分钟探测 | 仅盘中,`POSITION_REVIEW_HOUR`(14 点)后每日一次 |
| 开盘队列 `processPendingOrders` | max(风控间隔,15s) | 休市跳过 |
| 前瞻收益回填 | 10 分钟 | 1h 口径休市跳过;1d/2d 全天候 |
| 经济日历刷新 | `CALENDAR_POLL_MINUTES`(60m) | —(套餐不含端点时自动停用) |
| 宏观环境衰减重算 | 10 分钟 | — |
| 资金分配 `maybeRunAllocation` | 60s tick | 休市跳过;当日首 tick(盘前 04:00)立即执行,其后每 `ALLOCATION_INTERVAL_MINUTES`(15m)一轮 |
| 市场核验刷新 | `MARKET_CHECK_POLL_MINUTES`(10m) | — |
| 标的名录刷新 `refreshSymbolReference` | `SYMBOL_DIRECTORY_REFRESH_HOURS`(6h) | 全天候;启动 12s 后先 DB 暖表再抓最新(`ENABLE_SYMBOL_REFERENCE`) |
| 停牌监控 `pollTradingHalts` | `HALT_POLL_SECONDS`(60s,≥30s) | 休市跳过(`ENABLE_HALT_GUARD`;数据陈旧超约 3 倍间隔时 `isSymbolHalted` 自动 fail-open) |
| 券商对照轮询 `pollMirrorOrders` | 60s | 回填对照单撮合结果(env key 与附加账户都缺席时函数内直接跳过) |
| 券商净值快照 `takeBrokerSnapshots` | `BROKER_SNAPSHOT_SECONDS`(默认 30s,下限 10s) | env 账户 + 各附加账户逐个落 equity vs 内部净值快照;限频在函数内,休市自动降回 10 分钟,与对照轮询双入口先到先写 |

### `server/routes/api.js`
全部公开只读接口 + 一个受控触发:`/health`、`/status`(脱敏的最近一轮摘要 + 停牌监控概览)、`/portfolio`
(估值+持仓,持仓行含进程内 `halted` 停牌标记)、`/trades`(券商主账本下返回参照账户的镜像成交,
映射为同一行形状 + `bm-` id 命名空间 + `ledger` 标记,失败限频告警回退内部账本,030)、`/news`(服务端过滤/搜索/分页:
`sentiment`(含 neutral)/`tier`/`symbol`(分析主体精确)/`band`(来源可信度分层 0.85/0.65)/
`date`(美东日历日,单日视图)/`q`/`before` 游标,028)、`/snapshots`(RPC 采样,缺 RPC 回退)、
`/stats`、`/performance`(vs SPY;二者在券商主账本下由 statsService 切到参照账户口径 —— 净值指标来自镜像快照日度序列、已实现盈亏/胜率来自镜像成交加权均价重放,失败限频回退内部,030)、`/signal-stats`(信号质量)、`/macro`(regime/日历/宏观事件;`?date=` 历史日回溯分支)、`/macro/history`(逐日回溯 regime 序列,热力图数据源)、
`/shadow`(消融实验)、`/symbol/:symbol`(个股抽屉聚合)、`/quote/:symbol`(单票轻量报价,弹窗兜底轮询用,只走报价缓存不查库)、`/stream`(SSE)、`/pending-orders`、
`/pool`(候选池概览:预览行富化现价 + 时段/盘外价字段(`fmp.js#quoteDisplayFields`,首屏徽标用)+ 系统离场口径百分比,供"若现在买入"参考与入池价反事实区间;报价容忍度非休市 30s/休市 5 分钟——它也是 SSE 断线兜底路径,不应每次强制新 FMP 请求);`POST /run-cycle`(外部 cron 用,匿名共享 120 秒冷却,设 `ADMIN_TOKEN` 后要求请求头);
`/backtest`(回测运行列表,轻量无 result)、`/backtest/:id`(单轮全量结果)、
`POST /backtest/run`(发起回测,032:与 run-cycle 同构守卫但匿名冷却 30 分钟且只对成功发起计数 ——
每轮对未命中缓存的历史文章逐篇调 LLM;标的 ≤`BACKTEST_MAX_SYMBOLS`、窗口 ≤`BACKTEST_MAX_DAYS`、
成本 0–100bps 服务端钳制,`backtestStatus.running` 单飞 409)。
公开响应一律不暴露上游供应商名称(经 `metrics.js#sanitizeProviderText` 脱敏)。

### `server/routes/admin.js`
管理面接口,**强制** `ADMIN_TOKEN`(未配置整组 503;比较走 `authGuard.js` 常数时间;
失败按 IP 限流 15 分钟 10 次):`POST /verify`、`GET /status`(含模型名等内部信息)、
`GET /metrics`(cycle_runs 最近轮次/今日 LLM 成本/积压/拒绝原因)、`GET /decisions`(决策回放,
`?full=1` 带完整 messages)、`GET /advisor`(参数建议)、`POST /trading-halt`(kill switch)、
`POST /strategy`(主账户交易策略选择,024;非法预设 400、缺列 409)、
`POST /primary-ledger`(展示主账本切换,024;未配置券商/缺列开启时 409;成功后广播 `ledger` SSE 事件让在线仪表盘一次全量刷新原子换源,030)、
`GET|POST|DELETE /broker-accounts[...]`(多券商账户 CRUD,025/029;新增先校验凭据并拒绝重复绑定 ——
key_id 精确重复与 account_number best-effort 比对,同一物理账户不可挂多路镜像流;
isPrimary 指定主对照账户(029,仅 mirror_actual 用途、至多一个,优先于 env 默认账户
承担展示主账本/对照卡数据源);purpose 变更作废该账户 deferred 顺延单;
`POST /broker-accounts/:id/liquidate` 单账户清仓重置(撤单+市价清仓+作废在途镜像单);
删除先清该账户对照单/快照再删行,防外键置空后归并进 env 默认账户;列表脱敏)、
`GET /broker-accounts/positions`(全部券商模拟账户实时账户+持仓:env 默认账户 + 各启用附加账户
并发直连券商,单账户失败只标注 error;管理页「实时仓位」面板轮询用,无缓存)、
`POST /run-cycle`、`POST /reset`(全量数据重置)。

## 4. 服务层(`server/services/`)

### 4.1 数据源与基础设施

| 文件 | 职责与核心逻辑 |
|---|---|
| `fmp.js` | FMP(Financial Modeling Prep)API 封装,**价格唯一事实源**。`getQuote`:10s 缓存;非盘中合并 aftermarket 成交价为 `effective_price`(时间戳新于常规报价才采用,fail-closed 回退收盘价),附带 `session`。`getMarketSession`:pre/regular/post/closed 判定(半日市 13:00/17:00)。`getProfile`(24h 缓存)、`getQuotes` 批量、`quoteDisplayFields`(报价→前端展示字段的唯一映射:时段/盘外价/涨跌幅双字段兜底,估值/候选池富化/实时推送三处共用)、`getHistoricalPrices`(轻量日线,1h 缓存)、`getHistoricalPricesAdjusted`(股息调整总回报,SPY 基准用,失败回退未调整并标记 `basis:'price'`)、新闻三端点、经济日历端点。所有请求 20s 超时,错误计入 `metrics` |
| `yahoo.js` | 补充新闻源:关注列表(`WATCHLIST` + 持仓自动加入)每只股票的 Yahoo Finance RSS 头条,XML 轻量解析,失败静默 |
| `secFilings.js` | SEC EDGAR 监管文件源(026,log 前缀 `[sec]`,`ENABLE_SEC_FILINGS`):官方接口免密钥(仅申明 `SEC_USER_AGENT`),轮询全市场 8-K「最新提交」Atom 流(搭车 fullFetch 节奏),CIK→ticker 官方映射(24h 缓存,刷新失败沿用旧表 1h 后重试)过滤基金/私有主体,逐份抓主文档(index.json + 文件名启发式,并发 4)提取正文与事项条目编码,重大条目白名单(`SEC_8K_ITEM_WHITELIST`)外的例行披露直接丢弃(条目零命中=解析失败,fail-open 放行)。已见 accession 集合(LRU 2000,进程首轮从库预热)省重复抓取;**单份抓取失败不标已见,留在 feed 窗口下轮自动重试**;整源失败向上抛进 `summary.errors`。纯函数(Atom/映射/主文档挑选/剥 HTML/条目提取/标题构造)可单测;`clearSecFilingsState` 由管理重置调用(ticker 映射是外部数据,保留) |
| `deepseek.js` | 全部 LLM 调用的唯一出口(OpenAI 兼容 chat completions,强制 `response_format: json_object`,90s 超时,每次调用带 `purpose` 标签把时延/Token 报给 metrics)。**七个 prompt 常量**:分析师(个股四档分类)、宏观分析师、交易员(decideTrade,先做标的核验)、事件归并、宏观事件归并、风控官(reviewProposedTrade)、持仓复查、复盘反思。新闻标题/正文是不可信外部输入:一律经 `sanitizeUntrusted`(去控制符/bidi/截断)并用 `UNTRUSTED_NOTE` 框定"忽略内嵌指令"。输出在代码侧防御性钳制;`PROMPT_VERSIONS` 版本号随 prompt 文本变更递增(决策回放对齐用)。注意:交易员/风控官输出的止损建议自 ±2% 固定止损后仅存决策回放,不再影响成交 |
| `bus.js` | 进程内 SSE 总线:客户端集合管理 + `broadcast(event, data)`。事件名:`news`/`analysis`/`trade`/`portfolio`/`snapshot`/`cycle`/`reset`/`macro`/`quotes`/`ledger`(展示主账本切换,030)/`backtest`(回测进度与终态,032) |
| `quotesPush.js` | 实时报价推送(SSE `quotes` 事件,log 前缀 `[quotes]`):随报价推送 tick 广播「持仓 + 候选池 top-10」符号的紧凑报价映射(effective_price/extended_price/extended_change_percent/change_percent/session)——修复候选池在非常规时段现价/入池漂移冻结在旧收盘价的问题。持仓价**直接取自本 tick 的估值结果**(`positionsToQuotes`,不二次打 FMP,portfolio 与 quotes 事件同 tick 同价;报价缺失回退成本价的持仓跳过),只有池符号产生新报价请求(10s 容忍度);调度器**不 await**(慢 FMP 不拖 portfolio 推送节奏),模块级单飞旗标防重入;休市整轮限频 5 分钟 + 报价容忍度同步放宽;**内容签名去重**(载荷不变不重复广播,休市/横盘零流量);纯函数 `collectQuoteSymbols`/`positionsToQuotes`/`buildQuotesPayload` 可单测,`MAX_QUOTE_SYMBOLS=40` 硬上限;池符号清单进程内缓存 30s,`clearQuotesPushState` 由管理重置调用;fail-open,失败只 warn,池不可用退化为纯持仓推送 |
| `singleton.js` | 周期任务防重入包装:上一轮未结束的 tick 直接跳过;卡死超过 10 分钟按告警周期限频警告。模块内部的 `running` 旗标仍保留(另防手动触发并发) |
| `halt.js` | 全局暂停开关(进程内布尔):管理重置期间置位,runCycle/checkStops/openQueue/回填/分配器全部早退 |
| `authGuard.js` | `safeTokenEqual`(sha256 定长化 + timingSafeEqual 常数时间比较)与按 IP 的鉴权失败限流器(成功不计数) |
| `metrics.js` | 进程内可观测状态(纯内存,无 IO):当日 LLM 用量按用途分桶、FMP/DeepSeek 错误计数、当前运行累加器(`beginRun`/`endRun`/`currentRunId`/`recordReject`)、`etDayKey` 美东日键、`sanitizeProviderText` 公开文案脱敏 |

### 4.2 新闻 → 信号管线

| 文件 | 职责与核心逻辑 |
|---|---|
| `newsService.js` | **一轮交易循环的编排者 `runCycle()`**(全系统阅读入口)。① 抓取:快轮只拉个股新闻,约每 5 分钟全源(综合+公告+Yahoo+SEC 8-K);按 URL upsert 去重,只有真正新增的行进入后续(可选列 009/026 逐列剥离降级重试)。② 分析:候选来自"近 24h 未分析"积压查询(非仅本轮新增),每轮上限 `MAX_ANALYZE_PER_CYCLE`(8);无个股指向的综合新闻分流给宏观管线;分析后立即打 `analyzed_at`(失败下轮重试)。③ 信号门槛:非中性 + 档位 ≤ `TRADE_TIER_THRESHOLD`(2)+ 置信度 ≥0.5 才可交易;每条非中性分析记录信号时点价(评估层)。④ 事件去重/交叉确认(见 eventService)→ `handleSignal`。⑤ 结果记账:`pooled`(入池)/`refreshed`(同票利好刷新)/`queued`(挂单)/trade(成交)分别计数并消费事件;`finally` 里 `saveCycleRun` 落运行指标 |
| `credibility.js` | 来源可信度评分(0~1):按**文章原文域名**分层(通讯社/监管 0.95 → 新闻稿渠道 0.90 → 主流媒体 0.85 → 观点平台 0.65 → 低信 0.50 → 未知 0.40 → 无链接 0.25),FMP 转发再扣 0.03;`sec-filings` 渠道直抓的监管文件强制 1.00「监管披露」档(按渠道选中,媒体转发的 sec.gov 链接仍走 0.95 域名档)。`computeFinalConfidence` = 来源分 × LLM 置信度 × 时效分(1h 内 1.0 → 24h+ 0.5)× 档位分。`isPressRelease` 判定公告渠道(统计口径);`isSelfIssued` = 公告 ∪ 监管披露(公司自述类,利好共享 `PRESS_BULLISH_PENALTY` 门槛折价,利空不折价) |
| `newsDedup.js` | 近似重复判定纯函数:归一化分词(去停用词)→ Jaccard 相似度;`findDuplicateEvent` 同向且标题/事件概要相似度 ≥`EVENT_NEAR_DUP_SIMILARITY`(0.8)即确定性归并(LLM 归并的兜底);`clusterAnalyses` 供个股抽屉展示聚合 |
| `eventService.js` | 事件溯源与去重:`resolveEvent` 取同票近 `EVENT_DEDUP_HOURS`(72h)事件 → 先确定性近似判重,未命中再 LLM `matchEvent` → 重复报道只 `article_count+1` 并累计独立信源域名;未交易事件收到**新独立域名**报道 → 返回 `confirmable`(交叉确认:按新报道置信度 × 每源 +10%、上限 ×1.2 重评);新事件放行前还要过同票同向 30 分钟交易冷却(`checkCooldown`,也查 pending_orders)。**去重出错 fail-closed 跳过交易**。`markEventTraded` 消费事件,`checkTradeCooldown` 供分配器复查 |

### 4.3 交易执行(`trader.js` 为核心)

| 文件 | 职责与核心逻辑 |
|---|---|
| `trader.js` | **交易执行核心**(最大的文件)。`withTradeLock`:进程内交易互斥链。`handleSignal`(新闻信号入口):利好 → 准入门槛(eligibility)→ 影子信号钩子 → **同票已持有则确定性"利好刷新"**(重置 48h 持有时钟 + 止盈线上抬 `TAKE_PROFIT_STEP_PERCENT`,不入池不加仓,写失败 fail-closed 不消费事件)→ 入候选池(`poolBullishSignal`,记基础分/宏观快照/入池价,同票有待开盘卖单则出生即冲突搁置;**同票已有活跃候选则合并而非重插**(022):更强信号刷新信号字段,事件计数 `merged_events`+1、时效锚点/过期时钟续命,状态与入池价锚点不动,合并写落空(并发)也视同已入池不插重复行);池不可用退回旧即时路径(decideTrade→官审→成交)。利空 → 冻结同票买入候选 → 影子清仓钩子 → **`sellHeldPositionOnBearish` 确定性全仓清仓**(不经 LLM;未持有直接返回省一次调用;休市挂开盘队列)。`executeCandidate`(分配器调用):重查准入/冷却 → `decideTrade`(带宏观上下文,先标的核验)→ **代码强制止盈止损覆盖 LLM 建议(默认固定 ±2%;波动敞口开关开启时 `applyBracket` 按 20 日波动缩放,023)** → 仓位缩放链(档位/置信/来源 → 宏观×行业×冲突 → 连亏降仓 → 风控官 scale)→ `executeBuyStructured`(决策后重取报价,漂移 >5% 熔断)→ `settleBuyLocked`。`settleBuyLocked`(锁内买入结算,风控检查顺序):估值可信 → kill switch → 当日亏损熔断 → 最大持仓数 → macro_shock → 当日新仓配额 → 现金/单笔帽 → 单票 25% 帽 → regime 三重钳制(`computeBuyHeadroom`)→ 最小金额 → 行业集中度 → 滑点成交 → `execute_trade` RPC 原子落库 → 刷新持有时钟 → 影子镜像;临时拒绝带 `transient:true`(候选/挂单保留重试)。`executeQueuedBuy`:开盘队列买单,盘中按当日开盘价、盘前盘后按实时盘外价成交。`executeSellOrder`:统一卖出(重取报价+滑点,部分/全仓,realized_pnl 计算,触发复盘与影子镜像);`legacyBuy` 兼容缺 004 RPC 的旧库 |
| `eligibility.js` | 买入准入门槛纯函数(LLM 之前的硬拦截):交易所白名单(AMEX 别名归一)、上市名录校验(028,可选 `reference` 参数由调用方传入 `symbolReference.js` 同步查询结果——名录存在性(OTC/退市)/测试标的/财务异常状态(`classifyFinancialStatus`:D/E/Q/G/H/J/K)/名录 ETF/名录交易所补充白名单校验;名录未加载整组跳过)、ETF/基金拒绝(字段缺失放行——唯一刻意 fail-open)、最小市值 $3 亿、最低股价 $2、最低日均美元成交额 $500 万;其余档案缺失 fail-closed。`mapOtherExchangeCode`(A/N/P/Z/V→短代码)也在此(纯函数,parse 时用) |
| `symbolReference.js` | 标的名录(028,log 前缀 `[symref]`,`ENABLE_SYMBOL_REFERENCE`):官方符号目录(nasdaqlisted+otherlisted,免密钥)每 6h 刷新为进程内 Map(同步查询可进交易锁)+ `symbol_reference` 表镜像(缺表只停镜像;启动先 DB 暖表再异步刷新)。换表守卫:尾行完整性(File Creation Time)+ 行数下限,残缺下载绝不换表;符号 `.`→`-` 归一与报价源一致;管理重置不清(外部市场数据) |
| `tradingHalts.js` | 停牌守护(028,log 前缀 `[halts]`,`ENABLE_HALT_GUARD`):官方 Trading Halts RSS 盘中轮询(60s,休市跳过)→ 进程内生效中停牌 Map;`isSymbolHalted()` 同步且 **fail-open**(未启用/未就绪/数据陈旧 >3×间隔+60s 一律 false,绝不按幽灵停牌拦单)。消费方:settleBuyLocked 的 `symbol_halted` transient 总闸、executeCandidate 预检(省 LLM)、riskMonitor/shadow 止损跳过、利空卖单入队、openQueue 卖单复查、positionReview/腾位排除、持仓行 `halted` 富化 |
| `sizing.js` | 仓位缩放链纯函数:fraction × 档位乘数(1 档 ×1/2 档 ×0.7/其余 ×0.5)× 置信度乘数(0.5→×0.5,缺失 ×0.7)× 来源乘数(0.6~1,缺失不缩) |
| `execution.js` | 模拟成交真实化:滑点 = 市值分档半点差 × 时段乘数(盘前/盘后 ×3,休市 ×4)× 开盘窗口乘数(盘中前 15 分钟 ×2)× 当日波动乘数 + 订单冲击(占日均成交额比例)+ 佣金,封顶 `SLIPPAGE_MAX_BPS`;`computeFill` 返回成交价与 bps,`computePoolMetrics` 计算入池→成交漂移与等待时长(排队成本) |
| `riskControls.js` | 组合级硬风控(代码强制,只拦买入):当日亏损熔断(基线=美东今日前最后一条快照,sticky)、最大持仓数(加仓豁免)、行业集中度钳制、连亏降仓、当日新仓配额(重启按当日买单保守重播)、regime 三重钳制 `computeBuyHeadroom`(现金保留下限/当日买入预算/总敞口上限,取最紧)、当日预算的进程内记账(30s 缓存) |
| `holding.js` | 持仓时限纯函数(020):`holdAnchor`(hold_refreshed_at ?? opened_at)、`isHoldExpired`(超 `MAX_HOLD_HOURS` 判定;关闭或缺列返回 false)、`bumpTakeProfit`(止盈线按成本价逐事件 +step%) |
| `rotation.js` | 止盈腾位纯函数:盈利且有止盈价的持仓中选 `current_price/take_profit` 最大者(排除候选同票) |
| `riskMonitor.js` | 止损/止盈/持有时限监控循环:逐持仓取报价(`effective_price`),**先判持有超时**(48h,`trigger:'max_hold'` 全仓卖)再判止损/止盈触线(全仓卖);移动止损 `maybeTrailStop`(默认关,棘轮数学在 trailing.js,与 trailing_only 影子变体共用);休市跳过,缺 020 列警告一次后停用时限 |
| `trailing.js` | 移动止损棘轮纯函数(023,从 riskMonitor 抽取):`computeTrailedStop`——base=peak??avg_cost,距离保持首设,newStop=price×(1−distance),只在 ≥ 现值×1.005 时上抬 |
| `volatility.js` | 波动自适应敞口(023):纯函数 `dailyReturns`/`realizedVolPercent`(20 日样本标准差,<10 个收益 → null)/`computeBracket`(clamp(k×vol, min, max));IO `computeSymbolBracket`(EOD 历史 1h 缓存,失败返回 null 永不阻塞交易)。买入路径**无论开关都计算**:落 trades 证据链 + 喂 vol_bracket 影子变体 |
| `strategy.js` | 主账户交易策略运行时选择(024,取代 023 volBracket 开关):纯函数 `strategyBracket`(各策略的止损止盈宽度)/`strategyMaxHoldHours`(wide_bracket 96h)/`isEntryPathStrategy`;运行时状态持久化在 `portfolio_state.trading_strategy`(切非默认先写库后翻内存,切回 default 先翻内存;非法预设 400、缺列 409);`isVolBracketEnabled()` = 策略为 vol_bracket。入场路径类策略绕过候选池/LLM/风控官并暂停分配器,锁内硬风控对所有策略生效 |
| `primaryLedger.js` | 展示主账本切换(024):`portfolio_state.broker_ledger_primary`;`getPrimaryValuation()` 为主视图单一取数点(开→券商估值,失败回退内部,≤1 次/5 分钟告警;关→内部估值),/api/portfolio、SSE portfolio/snapshot、/api/snapshots、重置重广播全部经此;030 起 /api/stats、/api/performance、/api/trades 也按 `isBrokerLedgerPrimary()` 切源(取数在 brokerStats.js/statsService.js);未配置券商 key 开启时 409 |
| `openQueue.js` | 开盘队列(010):休市信号挂 `pending_orders`,下一可交易时段成交(买单盘中用开盘价/盘外用实时价,卖单经 executeSellOrder);超 96h 作废;transient 拒绝保留重试;表缺失整体停用退回即时成交 |
| `tradingHalt.js` | 人工 kill switch(013):持久化在 `portfolio_state.trading_halted`,只拦新开买入,卖出/止损永不受影响 |
| `positionReview.js` | 每日持仓复查:盘中 14 点后每日一次,单次 LLM 调用整体评估全部持仓(带各持仓同期 SPY 收益,按 alpha 评判);论点失效 → `trigger:'review'` 卖出,浮盈大 → 收紧止损(只紧不松);LLM 提到非持仓票直接丢弃 |
| `memoryService.js` | FinMem 式复盘记忆(006):平仓后异步 `reflectOnClosedTrade`(带同期 SPY/超额收益,判 alpha 非 beta)提炼可迁移教训入 `trade_reflections`;`getMemories` 取该票最近 + 全局最重要 ≤5 条注入后续决策/官审上下文 |
| `benchmark.js` | 持仓期 SPY 基准纯函数 + 取数:同日持仓 ≈ SPY 当日涨跌,跨日 = 股息调整收盘对收盘(`spyHoldingReturn` 纯函数);失败返回 null(fail-open 省略字段) |

### 4.4 宏观信号层(014–016)

| 文件 | 职责与核心逻辑 |
|---|---|
| `macroService.js` | 宏观事件管线:无个股指向的综合新闻 → `analyzeMacroArticle`(事件类型/风险方向/利率-通胀-增长/受影响行业/1–3 档/置信度)→ 先 LLM 归并判重(015,重复只 `article_count+1` 并小幅上调置信度,`created_at` 保持首报——防"续命";**判重失败 fail-open 照常插入**,与个股侧相反:漏掉宏观风险比多算一条更糟)→ `macro_events` 落库(带来源可信度,016);经济日历同日匹配时回填数值意外幅度;`listMacroEventsForDay`(历史日事件区间查询)与 `getMacroHistory`(逐日回溯 regime 序列,`aggregateRegimeSeries` 推算 + 10 分钟进程内缓存,`clearMacroHistoryCache` 在管理重置时清空) |
| `macroRegime.js` | regime 聚合(纯代码可测):有效窗口(72h)内事件按 档位权重(1.0/0.6/0.3)× 置信度 × 来源分 × 时间衰减 exp(−age/24h)加权,同类型同方向几何衰减(×0.6/条,防 LLM 判重漏)→ [-1,1] 风险分 → 四态 regime(滞回:进 ±0.30/出 ±0.20);一档高置信 risk_off 事件在**有佐证**(≥2 篇归并或 ≥2 独立域名,016)时硬触发 `macro_shock`(6h)。状态持久化 `macro_state` 单行,重启恢复;`getRegime()` 同步读进程缓存(锁内可用);`getEffectiveRegime()` = 新闻 regime ∩ 确定性市场核验(**唯一交集点**:仅当核验不同向时把 risk_on 钳到 neutral 参数,从不放松避险) |
| `marketCheck.js` | 确定性市场核验(016):SPY 相对 20 日均线(±0.5% 缓冲带)+ VIX 水平(<20 risk_on / ≥26 risk_off)推出与新闻无关的 regime;VIX 不可用退化为仅 SPY,SPY 不可用整体停用(fail-open) |
| `macroCalendar.js` | 经济日历:抓取 + 高重要性美国数据过滤 + 发布前后 ±30 分钟黑窗判定(`isInBlackout` 纯函数,黑窗内分配器不买,卖出/止损不受影响);套餐不含端点时 403/404 标记停用(fail-open);`getCalendarDayEvents` 按需拉取历史日的实际发布记录(按日缓存 ≤60 天,失败按不可用返回 null 不缓存) |
| `candidateStore.js` | 候选池存取(`candidate_signals`):入池/读活跃候选(≤200)/**乐观并发更新**(`expectedStatus` + `expectedUpdatedAt` 双重版本比对,防 ABA)/过期/同票冻结(`holdBuyCandidates`)/取消同票兄弟/状态计数。**同票合并**(022):`mergeCandidateFields` 纯函数(更强信号刷字段,永远 `merged_events`+1 并续命 `last_signal_at`/`expires_at`,永不动状态/入池锚点)+ `findActiveCandidate`(失败 fail-open 走插入)+ `mergeIntoCandidate`(乐观并发写,落空 fail-closed 不插行,缺列剥离降级);同票活跃唯一部分索引兜底,`enqueueCandidate` 撞 23505 重查归并返回、绝不返回 null 跌回即时交易路径。可复评状态:pending/capital_constrained/macro_filtered/conflict_hold;终态:allocated/rejected/expired/cancelled |
| `conflictResolver.js` | 多空冲突消解纯函数:同票反向信号按强度比(综合置信度 × 档位分,1.5× 为主导阈值)裁决——有待开盘卖单→搁置;利空主导且持仓→取消买入候选;势均力敌→搁置;利好主导→缩半仓放行(避险状态一律搁置);每轮重判,反向信号老化出 `CONFLICT_WINDOW_MINUTES`(120m)后自动解除 |
| `allocator.js` | **资金分配器**。上半部纯函数:`decayFactor` 时效衰减、`scoreCandidate`(档位×置信×时效×来源×宏观×行业;衰减锚 `last_signal_at ?? created_at`,022 合并续命)、`mergeBySymbol`(同票取最优+多事件小加成,事件数按组内 `merged_events` 之和——022 后主要作存量重复行安全网)、`rankCandidates`、`planAllocations`(取前 `MAX_ALLOCATIONS_PER_RUN`)。下半部编排 `runAllocation`:过期清理 → macro_shock 门(低分取消,不买)→ 黑窗门 → 资金闸门(上次预算拒绝的现金水位,未涨且未跨日不复评 capital_constrained 候选,省 LLM)→ 刷分(批量乐观写,<0.01 的纯分数变化跳过)→ regime 档位/置信过滤(`macro_filtered`)→ 冲突消解 → 合并排名 → 逐个 `executeCandidate`;**止盈腾位**:容量/现金类拒绝(`max_positions`/`cash_reserve`/`gross_exposure`)且本轮未腾位过 → 卖出最接近止盈价的盈利持仓(`trigger:'rotation'`)后重试一次。结果映射:成交→allocated+取消同票兄弟;预算类→本候选及所有更低分候选 capital_constrained + 设资金闸门;容量类→仅本候选;全局临时→本轮停止;永久→rejected |

### 4.5 影子组合 / 消融实验(017/019)

| 文件 | 职责与核心逻辑 |
|---|---|
| `shadowEngine.js` | 纯计算:买入金额硬帽(`computeShadowSpend`)、加权均价记账(`applyBuy`/`applySell`)、镜像仓位还原(`unscaleFraction`/`unapplyScale`——把实盘成交"反算"回未被风控官/宏观缩放前的仓位)、宏观拦截候选重放选取(`pickTopBlocked`)、估值(`valuePositions`)、休市顺延队列修剪(`prunePendingSignals`) |
| `shadowPortfolio.js` | 编排与落库。十六个变体(025 起每个可交易变体都有 *_rotation 腾位孪生——与基础变体逐项相同,仅在买入因**现金不足** no_spend 时先卖腾位选仓再重试一次(现金拉满重算 computeShadowSpend 仍为 0 = 约束是单票持仓帽/最小单额,腾位无济于事,直接跳过不清仓);trailing 系无止盈价,孪生按浮盈比例最高选仓 pickTopProfit):`no_risk_officer`(镜像实盘但还原官审缩仓,官否决的买入按否决前方案照买)、`no_macro_filter`(镜像用宏观钳制前仓位,regime 过滤/冲击/黑窗/结算期宏观拒绝拦下的买入照样重放)、**出场消融三件套(023,出场规则此前是唯一没被消融的层)**:`wide_bracket`(1:1 镜像,±4%/96h)、`trailing_only`(1:1 镜像,初始止损同实盘距离、无止盈,棘轮 `trailing.js#computeTrailedStop` 不依赖 ENABLE_TRAILING_STOP,棘轮锚点 `shadow_positions.peak_price`,缺 023 列停用棘轮告警一次)、`vol_bracket`(1:1 镜像,用 trader 每笔算好的波动 bracket——影子层零额外取数;取数失败回退实盘同宽;实盘开关开启后与实盘趋同=实验完成态);`immediate_trade`(独立:信号到达即确定性建仓,消融的是候选池+LLM 链)、`immediate_rotation`(024,独立:同即时成交,现金不足时先全仓止盈最接近止盈价的盈利仓再重试一次——shadowBuy 返回状态对象,no_spend 触发同一 enqueue 任务内的卖-买两步;与 immediate_trade 对比隔离腾位机制的净贡献)、`equal_weight`(独立:固定 5% 等权,消融 LLM 仓位)、`spy_benchmark`(一次性全仓 SPY)、`cash`。**镜像卖出触发器过滤(023 核心设计)**:信号驱动卖出(news/review/rotation)镜像进全部跟随变体,bracket 驱动卖出(stop_loss/take_profit/max_hold)跳过出场三件套——否则实盘 ±2% 止盈会拉平消融(已知近似:实盘 bracket 离场后,后续利空无实盘卖出可镜像)。关键机制:全部钩子 fire-and-forget 经进程内串行队列;**同一 (variant, analysis_id) 只买一次**(019 唯一部分索引,DB 级硬约束);**零额外 LLM 调用**(确定性仓位+默认止损,是消融近似而非回放);**休市信号顺延**(进程内队列,首个可交易 tick 按实时盘外价清算,96h 超龄作废,重启丢失可接受);`checkShadowStops` 对影子持仓做同口径 止损/止盈/时限 监控(每变体时限 `config.shadowVariantMaxHoldHours`,wide_bracket 96h 其余 48h;spy_benchmark 豁免时限;trailing_only 止损比较前先跑棘轮);快照搭车主循环 10 分钟限频;管理重置时截表重建变体 |

### 4.5b 券商模拟对照账本(021)

| 文件 | 职责与核心逻辑 |
|---|---|
| `alpacaBroker.js` | 券商模拟账户(Alpaca Paper)REST 薄客户端:下单(限价/市价,day 有效,可盘外——市价单须 extended_hours=false,盘外提交排队到下一常规时段)、查单(按 id/幂等键)、账户、单票持仓、撤全单、清全仓;原生 fetch + 15s 超时,错误抛出由调用方降级 |
| `mirrorPolicy.js` | 镜像单跟进策略(027,纯函数):`mirrorLimitPrice`(marketable 限价)、`remainingQty`、`nextRetryClientOrderId`(`-rN` 后缀)、`buyDriftPercent`、`planMirrorFollowUp`(顺延单 等待/提交/放弃 + 终态迁移 重挂/顺延重挂/市价升级/放弃 决策表;顺延**买单**超 `deferredBuyMaxAgeHours`(复用 `PENDING_ORDER_MAX_AGE_HOURS`)作废;顺延**卖单**不设时效但超龄且长期无报价(退市/长期停牌)→ 升级市价单交券商裁决,毒行不得永久占据轮询工作集)、`planBuyFunding`(镜像买单资金决策:现金账户语义 —— 足额提交/不足但有在途卖单回款可期则顺延(排除同票顺延卖单防互等死锁)/否则放弃,绝不动用保证金)、`committedBuyNotional`(在途买单现金占用:券商 cash 只在成交时变动,挂单冻结须本地记账,否则串行连发买单集体超买)、`planReconcile`(对账清理:券商独有全平/超额减仓/在途与内部独有跳过,永不买入对账);IO 全部留在 brokerMirror.js |
| `brokerMirror.js` | 对照账本编排(log 前缀 `[broker]`):实盘每笔成交 fire-and-forget 镜像为 marketable 限价单(限价=内部价±`BROKER_MIRROR_LIMIT_SLACK_PERCENT`,盘前盘后带 extended_hours,幂等键 `trade-{id}`);卖出以券商侧持仓为准(`adjustSellQty`);碎股被拒退整数股。**未成交跟进(027)**:休市时段不直接提交(当日限价单必然过期且限价基于过期报价),落 `deferred` 行由轮询在开盘后以实时价挂单(买单开盘漂移超限 → `abandoned`);在途单迁移到 expired/canceled/rejected 且有余量时按 `planMirrorFollowUp` 生成子行重挂(`attempt`/`retry_of` 记账,幂等键加 `-rN` 后缀,偏差基线始终是原内部成交价;卖单限价重试 `BROKER_MIRROR_MAX_RETRIES` 次后升级一次市价单保证收敛,买单限时追单——上行漂移超 `BUY_PRICE_DRIFT_ABORT_PERCENT` 或次数用尽放弃;休市观察到的迁移先落 deferred 子行;报价/持仓查询失败本轮不写终态,下轮重放整个迁移,崩溃任意点靠幂等键安全重放);每 30 轮轮询(约 30 分钟)入队一次**对账清理**(`reconcileSweep`,`BROKER_MIRROR_RECONCILE`):平掉"券商持有但对账基准账本已不持有/超额持有"的仓位(实盘镜像账户对内部账本、**影子变体账户对该变体的 `shadow_positions`**,unassigned 账户不清理;平仓单 `reconcile-{SYM}-{ET日期}[-a{id}]` 每天每票至多一次,后续收敛交同一套重挂机制),走串行队列排在既有镜像提交之后消除竞态。**镜像账户按现金账户语义运作**:买单(首挂/顺延提交/追挂)先过 `planBuyFunding` 现金约束(可用现金 = min(cash, non_marginable_buying_power),足额提交/不足但有在途卖单回款可期则落 `deferred` 等回款/否则 `abandoned`,绝不动用保证金账户的融资额度 —— 否则账户现金转负、敞口脱离被镜像账本);卖出在券商暂无持仓而**同票买单在途**时落 `deferred` 等买单落地后重定数量(买单放弃后自然收敛为 skipped),持仓查询/提交的瞬态失败一律落 `deferred` 由轮询重放,绝不静默丢单(此前直接抛错丢单 → 券商滞留孤儿持仓);422/403(参数级拒绝/买力不足或账户受限)落 error 终态防无限重放;顺延单被放弃(超龄/漂移/资金)前先按幂等键查一次券商侧订单,存在即按其真实状态收编落库 —— 覆盖"提交成功但落库前崩溃"的窗口;在途限价单超过 `BROKER_MIRROR_REPRICE_MINUTES`(15 分钟)未成交主动撤单,由既有重挂链按实时价重挂(day 单否则要等收盘过期才进重挂链,出场时效落后被镜像账本数小时)。轮询循环回填真实撮合结果并算**带方向偏差**(`signedDiffBps`,正值=对我们不利=内部滑点模型偏乐观);`takeBrokerSnapshots` 按 `BROKER_SNAPSHOT_SECONDS`(默认 30s,下限 10s,休市自动降回 10 分钟)写 equity vs 内部净值快照,`getBrokerSnapshots` 倒序取最近 5000 行窗口后反转并均匀降采样到 ≤600 点(030 修复:升序 + limit 会永远卡在最老窗口,账户运行数日后曲线冻结)。参照账户范围查询助手 `referenceSnapshotQuery`(支持 ltCreatedAt 定点查询)/`referenceOrdersQuery`(账户过滤 + 两级列回退公用)/`loadEquityBaseline` 均导出供 brokerStats.js(030)复用。**参照账户(029)**:展示主账本/对照卡/净值序列的数据源统一经 `brokerReference()` 解析 —— 管理页指定的主对照账户(`broker_accounts.is_primary`,仅 mirror_actual)优先,否则 env 默认账户(自此为遗留可选配置),可用性判定用 `hasBrokerReference()`;估值/盈亏基线缓存按参照 key 隔离,切换立即生效;mirror_actual 用途账户的快照同样记录 `internal_total_value`;`liquidateBrokerAccount` 支持单账户清仓重置(撤单+市价清仓+作废该账户在途镜像单,防重挂链把仓位买回)。纯函数(`signedDiffBps`/`adjustSellQty`/`summarizeMirror`——被 `retry_of` 引用的未成交终态行记 retried 出分母,deferred 按在途计、abandoned 计未成交)可单测。观测层约定:key 缺失/021 表缺失整体停用;缺 027 列时重挂降级停用(顺延/对账仍工作)警告一次;公开载荷不含供应商名;管理重置时券商侧撤单清仓 + 本地清表 |

### 4.6 评估层(011/016)与参数建议

| 文件 | 职责与核心逻辑 |
|---|---|
| `signalReturns.js` | 信号前瞻收益回填:每条非中性分析记录 `signal_price`;1h 口径在信号后 60–120 分钟窗口用实时价回填(休市窗口错过保持空);1d/2d 用日线收盘价(2d ≈48 小时,与持有上限对齐,031;旧 5d 口径停止回填,列保留),按**两条独立到期队列**(1d 满 24h、2d 满 72h 才进队,各 400 行/30 股票每轮,最老先处理),只采用早于今天的已定型 K 线;**股票冷却**防毒丸(取数失败/无日线冷却 12h,有日线但零填充冷却 2h);缺 `fwd_return_2d` 列(031 未执行)只停用 2d 口径警告一次,1h/1d 照常;`computeDailyForwardReturns` 纯函数 |
| `signalStats.js` | 信号质量统计(`/api/signal-stats`):`loadSignalRows` 分页取窗口内**有效行**(至少一个口径已回填,采样预算(`SIGNAL_STATS_MAX_ROWS`,默认 20000)不被未成熟信号挤占;缺 `fwd_return_2d` 列时剥离重试,2d 按 0 样本降级)+ 成交/候选状态/排队度量;`summarizeSignals` 纯聚合——按 全部/方向/档位/来源分层/置信度校准/交易 vs 拦截层(机会成本)/宏观环境/执行路径与排队时长 分桶的方向命中率(Wilson 95% CI)与平均收益、综合置信度 IC、排队成本总览;**实盘兑现**:`pairSellsToBuys`(卖单配对同票最近买单回溯源信号)+ `summarizeTradeOutcomes`(±2%/48h 口径:各桶的止盈/止损/超时离场分布、胜率、已实现盈亏);`wilsonInterval`/`pearson` 纯函数 |
| `parameterAdvisor.js` | 参数建议器(`/api/admin/advisor`,无 LLM 纯规则):低可信利好收益为负→提门槛;新闻稿利好命中率 CI<50%→加深折价;档位倒挂(1d,CI 不重叠)→复核分档;四类拦截层机会成本(被拦信号均值 ≥+0.3% 过度保守 / ≤−0.3% 确认价值);置信度校准倒挂;**实盘兑现规则**(止损占比 ≥55% → 信号与敞口不匹配;低可信桶止损过半 → 收紧来源门槛);影子对照(变体与实盘同窗收益差 ≥±2 个百分点,运行 ≥14 天)。每条规则带最小样本门槛,不显著保持沉默;只建议不改参 |

### 4.7 组合与统计

| 文件 | 职责与核心逻辑 |
|---|---|
| `portfolio.js` | 资金账户与持仓读取(`portfolio_state` 单行初始化)、`getValuation`(批量报价富化持仓:现价/市值/浮盈/占比,`missing_quotes` 标记估值可信度)、`takeSnapshot` 净值快照落库+SSE |
| `statsService.js` | 业绩统计:`getStats`(胜率/盈亏比/已实现盈亏等)与 `getPerformance`(净值曲线 vs SPY 总回报基准、年化夏普(仅实际交易日)、最大回撤)。券商主账本(030)分支:输入换成参照账户的镜像数据(`fetchBrokerStatsInputs`——镜像成交重放出 tradeRows、日度收盘 + 最新快照拼 snapRows、初始资金 = 净值基线),纯计算助手(`computeStats`/`toDailySeries`/`computeSharpe`/`getBenchmark`/`buildPerformance`)两条路径公用;券商侧失败 ≤1 次/5 分钟告警回退内部;载荷带 `ledger` 标记 |
| `mirrorLedger.js` | 镜像账本纯函数(030,零依赖可单测):`computeRealizedFromFills`(按 (成交时间,id) 稳定排序逐票重放,加权平均成本口径推导每笔卖出已实现盈亏;无在册成本基础的卖出(对账/清仓单)记 null 不计胜率;部分成交按 filled_qty、重试子单是独立 fill)、`fillsToTrades`(镜像成交行 → 内部 trades 行形状,`bm-` id 命名空间防与内部交易撞号,meta 按 trade_id 关联) |
| `brokerStats.js` | 券商主账本统计取数层(030,仅 IO):`fetchReferenceFills`(参照账户全量镜像成交,5000 行上限告警一次)、`fetchBrokerDayAnchors`(今日盈亏两条定点查询,与内部同构)、`loadBrokerDailyCloses`(日度收盘按日回走定点查询 + 按参照 key 隔离的进程内增量缓存,封顶 120 天 —— 30s 快照粒度下不可全量取数)、`listBrokerTrades`(/api/trades 分支:全量重放与 /api/stats 同源,进程内分页后仅对当页 trade_id 批量取内部交易 meta,meta 失败降级为空)、`clearBrokerStatsCache`(管理重置调用) |
| `adminService.js` | 全量数据重置:置全局 halt → drain 运行中的交易轮/分配轮/开盘队列在途批次 → 交易锁内经 `admin_reset_data` RPC 截断业务表(缺 005 迁移退回逐表删除)→ 现金恢复 `INITIAL_CAPITAL` → 清进程缓存 → 重置宏观状态 → 重建影子变体 → 广播 `reset` |
| `cycleRuns.js` | 每轮运行指标落库(012,fail-open):计数/耗时/LLM 用量/成本/供应商错误/拒绝原因分布/完整错误文本;可选列(pooled/macro_events/refreshed)缺列剥离重试 |
| `decisionLog.js` | LLM 决策回放(018,fail-open):每次 decideTrade 连同官审落一行 `trade_decisions`——prompt 版本、完整 messages(可原样重放)、输入 sha256、原始返回、normalized 决策快照(开始时拷贝,后续缩放不污染)、缩放链各步、价格快照、终局(executed/queued/hold/symbol_invalid/vetoed/officer_error/rejected/sell_skipped) |

### 4.8 策略回测(032)

参照 TradingAgents 论文的验证方法:用户选定标的 + 历史窗口,LLM 重析窗口内历史新闻得到
「AI 新闻策略」曲线,与五个经典基线(买入持有 / MACD / KDJ+RSI / ZMR 零均值回归 / SMA 双均线)
同窗对比,输出论文同款指标(CR% / 年化 / 夏普 / 最大回撤,另加交易次数与胜率 Wilson CI)。
论文口径:每标的独立账本(名义 1 万初始)、日频、多头-only 全进全出、默认零成本
(`BACKTEST_COST_BPS` 统一 bps 可配)。纯观测层:缺 032 表整体停用,绝不触碰交易路径。

| 文件(`server/services/backtest/`) | 职责与核心逻辑 |
|---|---|
| `indicators.js` | 纯指标数学:`sma`/`ema`/`macd`(DIF/DEA/hist)/`rsi`(Wilder)/`kdj`(RSV→K→D→J,种子 50)/`zscore`(样本标准差);暖机期 null,策略层对 null 保持仓位 |
| `strategies.js` | 五个基线的 targets 生成器(bars → 与之等长的 0/1 目标仓位数组):`buy_hold` 恒 1、`macd` hist 正负、`kdj_rsi` 超卖进(J≤20 或 RSI≤30)超买出(J≥80 或 RSI≥70,进出同触按离场)、`zmr` z≤−1 进 z≥0 出、`sma` 快慢线上下穿;参数在 `config.backtestParams`(论文未给精确定义,取业界常用口径) |
| `metrics.js` | 绩效指标(与 statsService 私有实现同口径,刻意拷贝不重构——那边在交易主链路上):`computeSharpe`(√252 年化,样本方差)、`maxDrawdownPercent`、`annualizedReturnPercent`(252 交易日)、`summarize`(CR/ARR/夏普/回撤/次数/胜率 + `signalStats.js#wilsonInterval` CI) |
| `aiSignals.js` | 分析行 → 信号时间线(纯函数):镜像实盘可交易门(非中性、tier≤阈值、conf≥0.5、final_confidence ≥ 门槛,利好自述来源 ×`PRESS_BULLISH_PENALTY`),时效分经 `credibility.js` 新增的 `nowMs` 参数**钉死在发布时刻**(否则历史文章全衰减到 0.5);执行日映射(发布在交易日收盘前 → 当日收盘,否则顺延下一交易日;半日市 13:00,DST 由 Intl 处理);**确定性归并**替代 LLM 事件链/跨源确认(近似,UI 披露):同(执行日,方向)取最高分,同日多空双双搁置;丢弃原因逐项计数(信号漏斗) |
| `engine.js` | 撮合引擎(纯函数):`runAiStrategy` 逐日事件顺序 = 开盘缺口(按开盘价成交,不给括号价优待)→ 盘中 low/high 触发(同根先止损,riskMonitor 先例)→ 收盘利空全平(news)→ 收盘持有超时(max_hold,48h≈2 根日线,墙钟毫秒比较)→ 收盘利好(持仓则 020 刷新:重置时钟 + `holding.js#bumpTakeProfit` 上抬;空仓全现金买入,±2% 括号自次日生效)→ 收盘 mark-to-market;`runTargetStrategy` 基线 shift-1(昨收盘决定今收盘执行,严格因果),buy_hold 首根建仓;窗口结束不强平按市值计;买卖双边 `costBps` |
| `backtestService.js` | IO 编排(log 前缀 `[backtest]`):五阶段 bars→news→analyze→simulate→persist;`backtestStatus` 单飞 + 每轮独立中止令牌(管理重置只标记当前轮,不误杀后续新轮);逐文章缓存 `(url, symbol, PROMPT_VERSIONS.analyst)` 命中 `backtest_analyses`(重跑/重叠窗口零 LLM 成本;缺表退化全量重析告警一次);`analyzeArticle(..., {purpose:'backtest-analyst'})` 复用实盘分析师 prompt(管理页成本独立分桶);文章总量护栏 `BACKTEST_MAX_ARTICLES` 超限即失败并提示缩窗;LLM 连续失败 ≥10 熔断;进度节流 1s 广播 SSE `backtest`;错误经 `sanitizeProviderText` 脱敏落库(公开读表);`cleanupStaleRuns` 启动时把遗留 running 标 failed;`clearBacktestState` 由管理重置调用 |

已知近似(结果页与本节双处披露):跨源确认/事件链不重放;成交只在日线粒度(括号按当日高低价、
跳空按开盘价近似);LLM 非确定性(未命中缓存的重析可漂移,temp 0.2 + 缓存缓解);日线为拆股调整
未含股息(六策略同口径内部可比,buy_hold 少计股息与论文价格回报口径一致)。

## 5. 数据库(`supabase/`)

### `schema.sql`
全新安装一次执行的完整 schema(所有迁移已折入)。表清单:

| 表 | 用途 |
|---|---|
| `portfolio_state` | 单行(id=1):现金、`trading_halted` kill switch、`vol_bracket_enabled` 波动敞口开关(023) |
| `positions` | 当前持仓:加权均价、止损/止盈价、`peak_price`(移动止损)、`opened_at`/`hold_refreshed_at`(48h 时限时钟) |
| `trades` | 全部成交:方向/数量/价格/理由/`trigger`(news/stop_loss/take_profit/review/max_hold/rotation)/`realized_pnl`/滑点与决策时间线/`macro_regime` 快照/`pool_*` 排队成本/每笔 bracket 宽度与 20 日波动快照(023) |
| `news_articles` | 新闻原文(URL 唯一):来源域名与可信度分(009);监管文件元数据 source_type/filing_form/filing_items(026);筛选索引 GIN(symbols) + analyses(sentiment,tier)(028) |
| `symbol_reference` | 标的名录(028):官方符号目录镜像(交易所/ETF/测试标的/财务状态),进程内 Map 的重启暖表与审计来源;管理重置**不**清(外部市场数据) |
| `news_analyses` | LLM 分析:方向/强弱/范围/档位/置信度/事件概要/`event_id`/`final_confidence`/`signal_price` 与前瞻收益 1h/1d/2d(011/031;5d 为已停用的历史口径,列保留)/run_id 与 LLM 用量(012) |
| `news_events` | 事件归并(去重主体):概要/报道数/独立信源域名数组/是否已触发交易 |
| `macro_events` / `macro_state` | 宏观事件分类结果(含来源分/佐证域名,016)与单行 regime 状态 |
| `candidate_signals` | 买入候选池(014):分数/状态机/宏观快照/入池价(016)/同票合并计数与时效锚点(022,同票活跃唯一索引) |
| `pending_orders` | 开盘队列(010):休市信号挂单,状态 pending/filled/cancelled/expired |
| `portfolio_snapshots` | 净值快照(盈亏曲线);`snapshots_sampled` RPC 采样 |
| `trade_reflections` | 平仓复盘教训(006,含同期 SPY/超额收益,016) |
| `cycle_runs` | 每轮运行指标(012;RLS 无公开读——错误文本含供应商名) |
| `trade_decisions` | 决策回放(018;RLS 无公开读——完整 prompt 含组合明细) |
| `shadow_portfolios/positions/trades/snapshots` | 影子组合四表(017;019 加变体+分析唯一索引;023 加 positions.peak_price 棘轮锚点);`shadow_snapshots_sampled` RPC |
| `broker_mirror_orders` / `broker_mirror_snapshots` | 券商模拟对照账本(021):逐笔镜像单与撮合回填(diff_bps 偏差)、账户净值对照快照;027 加 attempt/retry_of(重挂链记账)并把在途部分索引扩到 deferred,状态新增 deferred(休市顺延)/abandoned(追单放弃) |
| `backtest_runs` | 策略回测运行(032):params/progress/result 全 jsonb,LLM 用量与估算成本,error 已脱敏;公开可读,管理重置清空 |
| `backtest_analyses` | 回测逐文章分析缓存(032):`unique(url, symbol, prompt_version)` 命中键;公开可读,管理重置**不**清(昂贵外部派生缓存,沿 symbol_reference 先例;analyst prompt 变更须 bump `PROMPT_VERSIONS.analyst` 使旧缓存自然失效) |
| RPC | `execute_trade`(004,原子买卖:行锁、均价重算、按百分比重设止损止盈、现金增减)、`admin_reset_data`(005)、两个快照采样函数 |

RLS 约定:全表启用,公开只读(除 `cycle_runs`/`trade_decisions`);服务端 service_role 全权。

### `migrations/`(既有部署按序增量执行)
002 止损止盈列+统计索引 → 003 news_events → 004 execute_trade RPC → 005 admin_reset_data →
006 trade_reflections → 007 peak_price(移动止损)→ 008 成交真实化列(quote_price/slippage_bps)→
009 来源可信度列 → 010 pending_orders → 011 signal_price+前瞻收益列 → 012 cycle_runs+分析/成交的运行元数据 →
013 trading_halted → 014 宏观四表+候选池+trades.macro_regime → 015 宏观判重列(article_count 等)→
016 入池价/排队成本/宏观来源分/复盘 SPY 基准 → 017 影子四表 → 018 trade_decisions →
019 影子买入唯一索引 → 020 opened_at 补列+hold_refreshed_at+cycle_runs.refreshed(48h 时限)→
021 broker_mirror 两表(券商模拟对照账本)→
022 候选池同票合并(merged_events/last_signal_at + 存量重复清理 + 同票活跃唯一索引)→
023 出场策略层(shadow_positions.peak_price 棘轮锚点 + trades 每笔 bracket 宽度/波动快照 +
portfolio_state.vol_bracket_enabled 运行时开关)→
024 策略选择器与主账本(portfolio_state.trading_strategy 回填自 vol_bracket_enabled +
portfolio_state.broker_ledger_primary)→
025 腾位孪生与多券商账户(broker_accounts 表,RLS 无公开读;
broker_mirror_orders/snapshots 加 account_id/source_variant)→
026 SEC 监管文件源(news_articles 加 source_type/filing_form/filing_items)→
027 镜像单未成交跟进(broker_mirror_orders 加 attempt/retry_of,在途索引扩到 deferred)→
028 标的名录 + 新闻筛选索引(symbol_reference 表、GIN(symbols)、analyses(sentiment,tier))→
029 券商主对照账户(broker_accounts.is_primary,至多一个)→
031 前瞻收益 2d 口径(news_analyses.fwd_return_2d,回填待办索引改按 1d/2d;030 空缺)→
032 策略回测(backtest_runs + backtest_analyses 两表,admin_reset_data 加 backtest_runs)。

## 6. 前端(`web/`)

Vite + React 18 + Ant Design 5,暖炭金融终端设计语言(暖近黑底/陶土色交互点缀/虚线行分隔/
无渐变阴影,图标用 @ant-design/icons 且克制、绝不用 emoji),双主题默认暗色;净值曲线用
TradingView 开源的 lightweight-charts,其余图表 recharts;PnL 沿用美股惯例**绿涨红跌**
(唯一的数据编码色)。数据一律走 `/api/*`,实时性靠 SSE,SSE 断线才降级 60 秒轮询。

| 文件 | 职责 |
|---|---|
| `index.html` / `vite.config.js` | 入口与构建配置(`/api` 代理到 :3000,手动分包 antd/recharts/lightweight-charts) |
| `src/main.jsx` | React 挂载:ThemeProvider → ConfigProvider(按主题喂 antd 算法)→ AntApp(通知出口)→ App |
| `src/App.jsx` | 顶层路由(hash:主页/#/strategy/#/admin)与全局状态:EventSource 消费十一类 SSE 事件(portfolio/snapshot/quotes 全量应用,ledger 触发一次全量刷新原子换源,backtest 载荷透传回测页,其余触发定向重取;quotes 经 QuotesProvider 分发,reset 时清空),断线降级轮询,长驻状态封顶(快照 ≤600 点/新闻 ≤600 条) |
| `src/api.js` | fetch 封装 + 全部共享格式化函数与标签映射(档位/时段/触发/环境/候选状态/影子变体/拒绝原因) |
| `src/theme.js` | **颜色唯一事实源**:明暗两套调色板、`buildThemeConfig(mode)`(antd token)、图表/饼图/PnL 取色器 |
| `src/theme-context.jsx` | 主题上下文:localStorage 持久化,设 `<html data-theme>` 联动 CSS 变量 |
| `src/quotes-context.jsx` | 实时报价上下文:App 持有 SSE `quotes` 事件的 symbol→报价映射,候选池/个股抽屉经 `useLiveQuotes()` 消费(避免层层透传 props);SSE 断线或管理重置即清空,消费方回退拉取值 |
| `src/styles.css` / `src/fonts.css` | 双主题 CSS 变量、布局、签名工具类(`.label-caps`/`.display-num`/`.segbar`/`.chart-head`(净值图读数)/`.alloc`(配置条)/`.slband`(风控区间)/`.metric-row`/`.param-chip`)、价格闪烁动画(`.flash-up`/`.flash-down`,只用 `--up`/`--down`,受 reduced-motion 全局覆盖);自托管字体(Archivo Variable / JetBrains Mono——claude.ai 的 Styrene/Tiempos 为商业授权字体不可自托管,取其开源近似) |
| `components/Dashboard.jsx` | 主页装配:净值图 + 关键指标栏(2/3+1/3 网格)、持仓卡(资产配置条 + 持仓表,止损→止盈风控区间微条)、最近交易紧凑表 |
| `components/MetricsPanel.jsx` | 关键指标栏(累计收益/今日盈亏/已实现/夏普/胜率/回撤,行式指标) |
| `components/NetWorthChart.jsx` | 净值曲线(lightweight-charts):初始资金基线分色面积(上绿下红)、十字光标扫读时头部固定读数跟随(净值/盈亏/时刻/当刻成交单行省略,信息不挤悬浮框、不撑高卡片)、买卖点标记、SPY/GLD 基准虚线(日线收盘点裁到最后净值时刻——数据源当日未收盘行会悬空到"未来";窗口起点用前收盘补锚点;窗口内真实收盘点 <2 或覆盖率 <40% 时整条隐藏)、窗口切换,主题切换整体重建 |
| `components/ComparisonChart.jsx` | 多组合对比图(lightweight-charts,消融页两张卡共用):各组合一条相对收益 % 曲线,图例芯片数值随十字光标跟随、点击隐藏/显示该组合,0% 参考线 |
| `components/chartTime.js` | lightweight-charts 时间工具(本地时区平移/刻度与钟点格式化),NetWorthChart 与 ComparisonChart 共用 |
| `components/CandidatePool.jsx` | 候选池实时预览(状态/分数)+ 两层止盈止损参考:「若现在买入」锚定**现价** ±系统口径(朋友照此设单才正确,非常规时段带 盘前/盘后 ±% 徽标);「入池价反事实区间」进度条显示现价落在 [入池价−止损%, 入池价+止盈%] 何处,越界即标注"若入池即买已止盈/止损"(016 排队成本的可视化)。现价/时段经 SSE `quotes` 事件实时合并(`useLiveQuotes`,`/api/pool` 拉取值兜底),漂移随之实时重算 |
| `components/NewsFeed.jsx` | 新闻+分析流(服务端过滤/搜索/分页,SSE 触发刷新) |
| `components/NewsHeatmap.jsx` | 按票聚合的信号热力格 |
| `components/TradesPage.jsx` | 交易页:候选池/待开盘挂单 + 成交记录表。默认**单日视图**(今天,无成交回落到最近有成交的一天),DatePicker + 前后一天步进(选中早于已加载范围的日期按游标补拉一页);代码搜索为跨日期全量检索;另有方向/触发筛选,行展开显示决策依据与触发新闻 |
| `components/SymbolModal.jsx` | 个股抽屉:报价(含盘外)/持仓/事件聚类的分析历史/交易历史。报价取「live 或一次性拉取」的完整快照之一(不逐字段混用——live 盘外字段为 null 是有效信息),SSE 覆盖的持仓/池内票实时跳动;未覆盖符号打开期间每 15s 轮询轻量 `/api/quote/:symbol`(只换 quote 字段,带切换符号作废守卫,热力图选中日期不被打断) |
| `components/SignalStatsPage.jsx` | 「信号质量」页:窗口切换/截断提示/IC 卡/排队成本卡/**实盘兑现表**/各分桶组表(命中率按 CI 显著性着色) |
| `components/MacroPage.jsx` | 「宏观」页:regime 与生效参数、市场核验、经济日历与黑窗、宏观事件表(可展开摘要/板块);顶部热力图 + 日期筛选可回看历史日(`?date=` 历史分支,SSE 刷新只作用于实时视图),两张顶部卡等高、日历表内部滚动 |
| `components/MacroHeatmap.jsx` | 宏观环境日历热力图:`/api/macro/history` 逐日序列 → 周列网格,分歧色阶(绿=risk_on/正分、红=risk_off·shock/负分、灰=中性,深浅按 |risk_score| 对齐聚合阈值),点选联动整页;`cellEncoding` 纯函数 |
| `components/AblationPage.jsx` | 「消融实验」页:各变体净值曲线(窗口归一,ComparisonChart × 2——普通组 = 实盘+基础变体+SPY/现金,腾位组 = 实盘参照+全部止盈腾位孪生)、汇总对比、行展开(说明/胜率/持仓/成交)、券商模拟对照账本卡(021);页面可见时每 60s 静默刷新估值(影子符号不进 quotes 事件,量大不值盘外双倍配额) |
| `components/BacktestPage.jsx` | 「策略回测」页(032):发起卡(标的 tags ≤5 / 窗口 RangePicker / 成本 bps / 管理令牌,预填 sessionStorage 会话令牌)、运行历史表(SSE `backtest` 进度实时化 + running 时 5s 兜底轮询)、逐标的 ComparisonChart(AI 主线品牌色高亮、买入持有虚线)+ 指标表(CR/年化/夏普/回撤/次数/胜率±CI)+ 可展开成交明细 + 信号漏斗(丢弃原因计数),页脚口径与免责说明 |
| `components/FlashOnChange.jsx` | 数值变动闪烁通用组件:数值升/降时数字染 `--up`/`--down` 后 ~0.8s 渐回原色(key 重挂载保证连续变动重播;首挂载与 null 进出不闪)。只用于中性色数字(现价/总资产等),常驻红绿的盈亏文本豁免 |
| `components/SessionBadge.jsx` | 非常规时段徽标(盘前/盘后 ±%):持仓表与候选池共用,保证两处显示口径一致;无盘外价或盘中不渲染 |
| `components/AdminPage.jsx` | `#/admin`:令牌登录、运行指标、参数建议、决策回放、kill switch、手动触发、数据重置 |
| `components/StrategyPage.jsx` | `#/strategy`:面向访客的完整策略说明(与实现同步维护):策略一览 + 硬风控参数芯片墙 + 决策流水线折叠步骤 + 系统状态卡(自行拉取 `/api/status`,自仪表盘迁入) |
| `components/SegmentedBar.jsx` | 分段比例条(候选池/拒绝原因等处复用) |

## 7. 测试(`test/`,node:test,零外部依赖)

覆盖全部纯函数模块,CI 每次 push/PR 运行:

| 测试文件 | 对应模块/逻辑 |
|---|---|
| `marketCalendar.test.js` | 假日/半日市/交易日/距开盘分钟 |
| `execution.test.js` / `executionDisabled.test.js` | 滑点模型各因子与总开关 |
| `credibility.test.js` | 来源评分/综合置信度/新闻稿判定 |
| `newsDedup.test.js` | Jaccard 近似判重/事件聚类 |
| `sizing.test.js` | 仓位缩放链 |
| `eligibility.test.js` | 准入门槛各分支 |
| `riskControls.test.js` | 硬风控(熔断/持仓数/行业帽/三重钳制) |
| `holding.test.js` | 48h 时限锚点/到期判定/止盈上抬 |
| `rotation.test.js` | 止盈腾位选取 |
| `conflictResolver.test.js` | 多空冲突裁决 |
| `allocator.test.js` | 打分/衰减/合并/排名/计划 |
| `macroRegime.test.js` | regime 聚合/滞回/冲击佐证/按日回溯序列(`aggregateRegimeSeries` 滞回链) |
| `macroCalendar.test.js` | 意外幅度/黑窗判定 |
| `marketCheck.test.js` | SPY/VIX 分类与交集钳制 |
| `benchmark.test.js` | SPY 持仓期收益 |
| `signalReturns.test.js` | 日线前瞻收益纯函数 |
| `signalStats.test.js` | 统计聚合/Wilson 区间/IC/**卖买配对与实盘兑现聚合** |
| `parameterAdvisor.test.js` | 全部建议规则(信号/兑现/影子) |
| `shadowEngine.test.js` | 影子记账纯函数/镜像还原/**顺延队列修剪** |
| `brokerMirror.test.js` | 券商对照纯函数(带符号偏差/卖量调整/汇总统计含重挂链) |
| `mirrorPolicy.test.js` | 镜像单跟进策略(027):顺延/重挂/市价升级/追单漂移闸/对账清理决策表 |
| `quotesPush.test.js` | 实时报价推送纯函数(符号去重/截断、持仓→报价映射、载荷字段兜底与剔除、`quoteDisplayFields`) |
| `cycleRuns.test.js` / `decisionLog.test.js` / `metrics.test.js` / `singleton.test.js` | 观测层与调度包装 |
| `backtestIndicators.test.js` | 回测指标数学(SMA/EMA/MACD/RSI Wilder/KDJ/zscore)手算校验 |
| `backtestStrategies.test.js` | 五个基线 targets 生成器(暖机/进出场转换) |
| `backtestMetrics.test.js` | 回测绩效(夏普/回撤/年化/汇总与 Wilson CI) |
| `backtestSignals.test.js` | 信号推导:实盘门镜像、执行日映射(DST/半日市/周末顺延)、自述折价、归并与冲突 |
| `backtestEngine.test.js` | 撮合引擎:shift-1 因果、同根先止损、跳空开盘价、max_hold、020 刷新、成本 bps、数据缺口顺延 |

## 8. 关键横切约定(改代码前必读)

1. **日志前缀**按模块:`[cycle] [trader] [risk] [fmp] [event] [api] [scheduler] [admin] [memory] [review] [riskofficer] [queue] [signal] [metrics] [macro] [calendar] [pool] [allocator] [market] [shadow] [decision] [advisor] [quotes] [sec] [symref] [halts] [backtest]`;注释/日志/UI 文案一律简体中文,标识符英文。
2. **迁移容忍**:任何 schema 变更必须让旧库优雅降级(strip-and-retry 或警告一次后停用),新增迁移同时折入 schema.sql 并更新 README 部署清单。
3. **公开面不暴露供应商**:FMP/DeepSeek/Yahoo/模型名只出现在文档与 token 门控的管理面。
4. **新增纯逻辑先抽模块加测试**(sizing/eligibility/holding/rotation 先例);LLM 调用必须走 deepseek.js 并带 purpose,新 prompt 引用文章文本必须沿用 sanitizeUntrusted + UNTRUSTED_NOTE 框架;改交易员/风控官 prompt 文本要给 `PROMPT_VERSIONS` +1。
5. **热路径禁止随手加 LLM 调用**:成本结构依赖"分析每轮 ≤8 条、交易决策只发生在分配器头部候选"。
6. **新增 SSE 事件要两端同时接线**(bus.js broadcast + App.jsx 消费);新增环境变量要同步 `.env.example`/`README.md`/`render.yaml` 三处。
