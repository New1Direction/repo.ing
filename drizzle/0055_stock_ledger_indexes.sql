-- Read indexes for the stock ledgers of migration 0054 (docs/STOCK_QUOTES.md, "Stock ledgers"), matching their SOL
-- counterparts: a stock-paired market's 24-hour volume reads its trades by time, its activity reads its fee events newest
-- first, and launcher earnings and reconciliation read its settled fee collections. Without them each of those reads scans
-- the market's whole history. Indexes only: no table, column, constraint, trigger or row changes.
-- Expand-only and idempotent: every index is created only if missing, so re-applying this file changes nothing. The stock
-- tables are empty until stock-paired markets launch, so each index builds instantly.
-- All pending migrations run in one transaction, so the locks taken below are held until it commits: give up after 5s
-- (the deploy fails and can simply be retried) rather than queue every page query behind a long-running read.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- A market's trades in a time window (its 24-hour volume on the token page, lists and market APIs), as trade_events' by pool.
CREATE INDEX IF NOT EXISTS "stock_trade_events_repo_traded_at" ON "stock_trade_events" ("github_repo_id", "traded_at");
--> statement-breakpoint
-- A market's fee events newest first (its activity), as fee_events_repo_slot.
CREATE INDEX IF NOT EXISTS "stock_fee_events_repo_slot" ON "stock_fee_events" ("github_repo_id", "slot" DESC, "event_index" DESC);
--> statement-breakpoint
-- A market's collections by status (settled ones for launcher earnings and reconciliation).
CREATE INDEX IF NOT EXISTS "stock_fee_collections_repo_status" ON "stock_fee_collections" ("github_repo_id", "status");
