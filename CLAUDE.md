# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

AI 新闻交易员 — a news-driven US stock paper-trading site. It fetches financial news (FMP API + Yahoo RSS), has DeepSeek classify each article as bullish/bearish on a four-tier scale, lets DeepSeek decide simulated buy/sell orders under server-side risk constraints, and shows the portfolio live in a React dashboard. Everything is virtual money; there is no real brokerage integration.

## Commands

```bash
npm install                # root deps (Express server)
npm run build              # cd web && npm install && vite build → web/dist
npm start                  # node server/index.js → http://localhost:3000 (serves API + built frontend)

# Frontend dev with hot reload (two terminals):
npm start                  # terminal 1: backend on :3000
cd web && npm run dev      # terminal 2: Vite on :5173, /api proxied to :3000
```

- Requires Node >= 22. There are no tests and no linter configured.
- `.env` (copy from `.env.example`) needs `FMP_API_KEY`, `DEEPSEEK_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. The server still boots without them (API + static hosting work) but the scheduler does not start. All tunables live in `server/config.js`; document new env vars in `.env.example`, `README.md`, and `render.yaml`.
- Database: run `supabase/schema.sql` in the Supabase SQL Editor for a fresh install; existing deployments apply incremental scripts from `supabase/migrations/` instead.
- Deployed on Render via `render.yaml` (build = `npm install && npm run build`, start = `npm start`, health check = `/api/health`).
- Manual trigger for a full cycle: `POST /api/run-cycle` (requires `x-admin-token` header if `ADMIN_TOKEN` is set).

## Architecture

Single Node process: Express serves `/api/*` and the built frontend from `web/dist`, and `server/scheduler.js` runs four `setInterval` loops. There is no queue or worker — all background work happens in-process, guarded by simple re-entrancy flags (`cycleStatus.running`, `running` in riskMonitor).

### The trading pipeline (core flow)

`runCycle()` in `server/services/newsService.js` orchestrates one round and is the place to start reading:

1. **Fetch** — `fmp.js` (stock/general/press news) + `yahoo.js` (RSS for watchlist + held symbols). Fast polls (every `NEWS_POLL_SECONDS`, default 20s) only fetch stock news; roughly every 5 minutes a `fullFetch` round adds the other sources. Articles are upserted into `news_articles` with `onConflict: 'url', ignoreDuplicates: true`, so only genuinely new rows flow onward.
2. **Analyze** — `deepseek.js#analyzeArticle` returns sentiment, impact strength/scope, confidence, and a one-line `event_summary`. Tier is computed in code by `computeTier` (1 = strong+wide … 4 = weak+narrow), not by the LLM. A signal is actionable only if non-neutral, `tier <= TRADE_TIER_THRESHOLD` (default 2), and confidence ≥ 0.5.
3. **Dedup** — `eventService.js#resolveEvent`: DeepSeek compares the event summary against the symbol's `news_events` rows from the last `EVENT_DEDUP_HOURS` (72h); duplicate coverage of the same underlying event only bumps `article_count` and never trades again. New events still pass a same-direction trade cooldown (`TRADE_COOLDOWN_MINUTES`, 30min) on the `trades` table. **Fail-closed convention:** if dedup checks error out, the trade is skipped — prefer missing a trade over double-trading.
4. **Trade** — `trader.js#handleSignal` fetches quote + company profile, then `deepseek.js#decideTrade` must first pass *symbol validation* (is the news subject really this listed company? do price/market-cap magnitudes match the story?) before choosing buy/sell/hold. This guards against mapping pre-IPO companies to similar tickers (e.g. SpaceX ≠ SPCE). Validation failure forces hold; `isActivelyTrading === false` profiles are skipped before the LLM is even asked. Risk caps are enforced in code, not by the LLM: single position ≤ 25% of portfolio, single buy ≤ 20% of total value, min order $50, long-only. Buys store AI-chosen `stop_loss`/`take_profit` prices on the position (clamped to 3–15% / 5–30%).

Separately, `riskMonitor.js#checkStops` (every `RISK_CHECK_SECONDS`, skipped while market is closed) sells the full position when price crosses stop-loss/take-profit, reusing `trader.js#executeSellOrder` with `trigger: 'stop_loss' | 'take_profit'` (news trades use `trigger: 'news'`).

### Real-time push (SSE)

`server/services/bus.js` keeps the set of SSE clients for `GET /api/stream`. Backend code calls `broadcast(event, data)` at each pipeline step; event names are `news`, `analysis`, `trade`, `portfolio`, `snapshot`, `cycle`. Quote/valuation pushes (every `QUOTE_PUSH_SECONDS`) only run while `clientCount() > 0` to save FMP quota. The frontend (`web/src/App.jsx`) consumes these via `EventSource`: `portfolio`/`snapshot` carry full payloads applied directly to state, the other events trigger targeted re-fetches. When SSE drops, the UI falls back to 60s polling. If you add a new event type, wire both sides.

### Prices and market sessions

`fmp.js#getQuote` is the single source of price truth: outside regular hours it merges the FMP aftermarket-trade price and exposes `effective_price` (use this, not `price`, for valuation/fills/stop checks), plus `session` (`pre`/`regular`/`post`/`closed` computed from US Eastern time) and `extended_price`. Quotes are cached ~10s and profiles 24h in in-process Maps.

### Database conventions

- Supabase Postgres accessed only from the server with the `service_role` key (`server/db.js`); RLS allows public read on all tables, writes bypass RLS. The frontend never talks to Supabase directly — everything goes through `/api/*`.
- `portfolio_state` is a single-row table (`id = 1`) holding cash; positions use weighted-average cost; `trades.realized_pnl` is set on sells.
- **Migration-tolerant code:** schema changes ship as `supabase/migrations/NNN_*.sql` (also folded into `schema.sql`), and server code degrades gracefully when a migration hasn't been applied — e.g. `analyzeAndStore` retries without `event_summary`, `/api/snapshots` falls back when the `snapshots_sampled` RPC is missing. Follow this pattern when touching the schema.

### DeepSeek usage

All LLM calls go through `chatJSON` in `server/services/deepseek.js` (OpenAI-compatible chat completions with `response_format: json_object`, 90s timeout). The three prompts (analyst, trader, event-matcher) live in that file as constants and demand strict JSON shapes; outputs are defensively clamped/validated in code. Cost is bounded by `MAX_ANALYZE_PER_CYCLE` (default 8 articles per round) — keep that in mind before adding LLM calls to hot loops.

## Conventions

- ESM throughout (`"type": "module"`); plain JavaScript, no TypeScript, no framework beyond Express/React.
- Comments, log messages, commit messages, and all user-facing UI copy are written in Simplified Chinese; identifiers are English. Logs are prefixed by module: `[cycle]`, `[trader]`, `[risk]`, `[fmp]`, `[event]`, `[api]`, `[scheduler]`.
- The UI is a deliberately emoji-free, terminal-style dark dashboard (single stylesheet `web/src/styles.css`); shared formatters and label maps (`TIER_LABELS`, `SESSION_LABELS`, `TRIGGER_LABELS`) live in `web/src/api.js`.
- External calls (FMP, Yahoo, DeepSeek) use native `fetch` with `AbortSignal.timeout(...)`; per-source failures are collected and logged, never allowed to kill a whole cycle (`Promise.allSettled` in fetch, try/catch per article in analyze).
