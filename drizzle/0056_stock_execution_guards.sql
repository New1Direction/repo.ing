-- Guards and a read index for executing stock fee collections and launcher payouts (docs/STOCK_QUOTES.md, "Execution (off by
-- default)"; src/stock-execution-store.mjs). A transaction settles at most one collection and one payout: a signature can be
-- stored on only one row of each table, so the same money is never counted twice. The custody gate reads a stock's payouts by
-- status before every payout. Indexes only: no table, column, constraint, trigger or row changes.
-- Expand-only and idempotent: every index is created only if missing, so re-applying this file changes nothing. The stock
-- tables are empty until stock-paired markets launch, so each index builds instantly.
-- All pending migrations run in one transaction, so the locks taken below are held until it commits: give up after 5s
-- (the deploy fails and can simply be retried) rather than queue every page query behind a long-running read.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- One collection per transaction signature (rows aborted before they were signed carry none).
CREATE UNIQUE INDEX IF NOT EXISTS "stock_fee_collections_signature_unique" ON "stock_fee_collections" ("signature") WHERE "signature" IS NOT NULL;
--> statement-breakpoint
-- One payout per transaction signature.
CREATE UNIQUE INDEX IF NOT EXISTS "stock_launcher_payouts_signature_unique" ON "stock_launcher_payouts" ("signature") WHERE "signature" IS NOT NULL;
--> statement-breakpoint
-- A stock's payouts by status: the custody gate sums its settled and pending payouts before a payout is signed.
CREATE INDEX IF NOT EXISTS "stock_launcher_payouts_asset_status" ON "stock_launcher_payouts" ("asset_id", "status");
