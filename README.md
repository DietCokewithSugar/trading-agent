# 🤖 AI 新闻交易员 — 基于新闻的美股模拟交易网站

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

## 技术栈

- **后端**: Node.js + Express,SSE 实时推送 + 秒级轮询调度
- **前端**: React + Vite + Recharts(构建后由后端静态托管)
- **数据**: [FMP API](https://site.financialmodelingprep.com/developer/docs)(新闻 + 实时报价)、Yahoo Finance RSS(补充新闻源)
- **AI**: [DeepSeek API](https://api-docs.deepseek.com/)(新闻分析 + 交易决策,模型可配置)
- **存储**: Supabase (PostgreSQL)
- **部署**: Render(`render.yaml` Blueprint)

## 部署步骤

### 1. 初始化 Supabase

1. 在 [supabase.com](https://supabase.com) 创建项目;
2. 打开 **SQL Editor**,执行仓库中的 [`supabase/schema.sql`](supabase/schema.sql);
3. 在 **Project Settings → API** 记下 `Project URL` 和 `service_role` key。

### 2. 部署到 Render

1. 将本仓库推送到你的 GitHub;
2. 在 [Render](https://render.com) 控制台选择 **New + → Blueprint**,关联本仓库(自动读取 `render.yaml`);
3. 在服务的 **Environment** 中填入:
   - `FMP_API_KEY` — FMP Ultimate 订阅的 API Key
   - `DEEPSEEK_API_KEY` — DeepSeek 平台的 API Key
   - `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`
4. 部署完成后访问服务 URL 即可。

> ⚠️ **注意**:Render Free 计划的服务无流量时会休眠,定时抓取/交易会停摆,建议使用 Starter 及以上计划。若坚持用 Free 计划,可用外部定时服务(如 cron-job.org)定时请求一次 `POST https://你的域名/api/run-cycle` 来代替内置定时器。

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
| `SNAPSHOT_SECONDS` | `60` | 净值快照间隔(秒),决定盈亏折线图粒度 |
| `MAX_ANALYZE_PER_CYCLE` | `8` | 每轮最多分析的新闻条数(控制 DeepSeek 成本) |
| `INITIAL_CAPITAL` | `100000` | 模拟账户初始资金(美元) |
| `TRADE_TIER_THRESHOLD` | `2` | 触发交易的最低档位 |
| `WATCHLIST` | 七巨头 | Yahoo RSS 抓取的关注列表,持仓自动加入 |
| `ENABLE_YAHOO` | `true` | 是否启用 Yahoo Finance RSS 补充源 |
| `ADMIN_TOKEN` | 空 | 设置后手动触发接口需要鉴权 |

## API 一览

| 接口 | 说明 |
|------|------|
| `GET /api/portfolio` | 组合概览(现金、总值、盈亏、持仓+实时报价) |
| `GET /api/snapshots` | 净值快照序列(盈亏折线图数据) |
| `GET /api/trades` | 交易记录(含买卖原因、关联新闻) |
| `GET /api/news` | 新闻流(含 DeepSeek 分析结果) |
| `GET /api/stream` | SSE 实时推送流(news / analysis / trade / portfolio / snapshot / cycle) |
| `GET /api/status` | 调度器状态 |
| `POST /api/run-cycle` | 手动触发一轮抓取/分析/交易 |
| `GET /api/health` | 健康检查 |

## 常见问题

**部署后日志出现 `Node.js 20 detected without native WebSocket support` 警告?**
这是 `@supabase/supabase-js` 的 Realtime 模块在 Node < 22 下的提示。本项目不使用 Realtime 功能,该警告无害;但建议使用 Node 22+(`render.yaml` 已配置 `NODE_VERSION=22`)。如果你的 Render 服务是在旧配置下创建的,请到服务的 **Environment** 页将 `NODE_VERSION` 改为 `22` 并手动重新部署即可消除警告。

## 免责声明

本项目仅为模拟交易与技术演示,所有"买入/卖出"均为虚拟操作,不构成任何投资建议。
