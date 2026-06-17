# AGENTS.md

For architecture, conventions, and the full command reference, see `CLAUDE.md` and `README.md`. Standard commands live in `package.json` (`npm start` / `npm run build` / `npm test`).

## Cursor Cloud specific instructions

Services (single Node process, Node >= 22):

- **Backend + scheduler** — `npm start` (`node server/index.js`) serves `/api/*` and the built frontend on `http://localhost:3000`. This one process also runs all ~12 in-process scheduler loops (news poll, quotes, trading pipeline, macro, shadow). There is no separate worker/DB/queue to start locally — Supabase, FMP, and DeepSeek are all remote SaaS.
- **Frontend** — built static bundle (`web/dist`) served by the backend. For hot-reload dev only, run `cd web && npm run dev` (Vite on `:5173`, proxies `/api` → `:3000`).

Non-obvious caveats:

- **Build before run for the UI:** the backend only serves the dashboard if `web/dist` exists. Run `npm run build` (which also installs `web/` deps) before `npm start`, otherwise `http://localhost:3000` returns a "前端尚未构建" placeholder and only `/api/*` works. The update script installs deps but intentionally does not build, so build once per session if you need the UI.
- **Required secrets** (`FMP_API_KEY`, `DEEPSEEK_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) are injected as env vars in Cloud. The server always boots, but `assertConfig()` only starts the scheduler when all four are present — without them you get static hosting + failing data endpoints and no trading/news activity (look for `[server] 因缺少环境变量,定时任务未启动`).
- **`ADMIN_TOKEN` is set in this environment.** Admin endpoints (`/api/admin/*`) and manual cycle triggers therefore require the `x-admin-token: $ADMIN_TOKEN` header; the hidden admin UI is at route `#/admin`. Failed attempts are IP-rate-limited.
- **Trigger the full pipeline on demand** (news fetch → DeepSeek analysis → trade decisions) without waiting for the 20s poll: `curl -X POST -H "x-admin-token: $ADMIN_TOKEN" http://localhost:3000/api/run-cycle`. It returns `{"started":true}` and runs async — watch backend logs for `[cycle] 完成: ...`. Anonymous triggers share a global 120s cooldown.
- **The Supabase database is shared and persistent** (it already contains real portfolio/positions/trades). `POST /api/admin/reset` wipes all business data and resets cash — do not call it unless you intend to destroy that state.
- `npm test` is pure-function unit tests; it needs no env vars or network.
