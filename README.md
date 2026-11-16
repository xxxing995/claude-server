# claude-server

部署命令：npx wrangler dev

## 缓存统计

- `messages.cached_tokens` / `messages.cache_write_tokens` 由后端从上游返回的 `usage` 里读取后写入，provider 没返回时写 `null`（不写 0）。加列 SQL 见 `claude-page/2026-11-17/cache-stats/outputs/add-message-cache-columns.sql`。
- `GET /api/cache-stats`（需 `X-Access-Code`）返回命中率总览、按天分布、按间隔分布与按单价估算的累计节省，口径见 `claude-page/docs/backend.md`。
