-- Live chart trades (src/live-trades.mjs; docs/CHARTS_AND_RESPONSIVENESS.md, "Live trades"). About a second after a SOL
-- market's swap is confirmed, the worker writes its canonical swap event here. Charts show it after the newest finalized
-- trade, marked as confirming, until the finalized ledger (trade_events, damm_trade_events) holds the same swap. Display only:
-- no ledger, fee, claim, payout, P&L, analytics or alert reads this table. Every row is deleted two minutes after it arrived.
-- Expand-only and idempotent: one new table with its indexes and trigger, each created only if missing. No existing table,
-- function or row changes.
-- All pending migrations run in one transaction, so the locks taken below are held until it commits: give up after 5s
-- (the deploy fails and can simply be retried) rather than queue every page query behind a long-running read.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "live_trade_events" (
  "signature" varchar(88) NOT NULL,
  "event_index" integer NOT NULL,
  "github_repo_id" bigint NOT NULL REFERENCES "markets"("github_repo_id"),
  "venue" varchar(4) NOT NULL,
  "pool" varchar(44) NOT NULL,
  "slot" bigint NOT NULL,
  "traded_at" timestamptz NOT NULL,
  "direction" varchar(4) NOT NULL,
  -- Lamports into the pool on a buy, out of it on a sell; the market token's raw units the other way.
  "quote_amount" numeric(20, 0) NOT NULL,
  "base_amount" numeric(20, 0),
  -- The pool's post-swap Q64 square-root price, as the finalized ledgers store it.
  "next_sqrt_price" numeric(39, 0) NOT NULL,
  "received_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "live_trade_events_pkey" PRIMARY KEY ("signature", "event_index"),
  CONSTRAINT "live_trade_events_venue_check" CHECK ("venue" IN ('DBC', 'DAMM')),
  CONSTRAINT "live_trade_events_direction_check" CHECK ("direction" IN ('buy', 'sell')),
  CONSTRAINT "live_trade_events_evidence_check" CHECK ("event_index" >= 0 AND "slot" > 0 AND "quote_amount" > 0
    AND ("base_amount" IS NULL OR "base_amount" >= 0) AND "next_sqrt_price" > 0)
);
--> statement-breakpoint
-- The chart's read: one market's rows from its newest finalized slot on.
CREATE INDEX IF NOT EXISTS "live_trade_events_repo_slot" ON "live_trade_events" ("github_repo_id", "slot");
--> statement-breakpoint
-- The worker's two-minute expiry.
CREATE INDEX IF NOT EXISTS "live_trade_events_received" ON "live_trade_events" ("received_at");
--> statement-breakpoint
-- The same invalidation hint a finalized trade sends (0023), so open charts re-read at once. PostgreSQL delivers identical
-- notifications from one transaction once, so a multi-row insert or the expiry's delete hints each market once.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'repoing_live_trade_update' AND tgrelid = '"live_trade_events"'::regclass) THEN
    CREATE TRIGGER repoing_live_trade_update AFTER INSERT OR DELETE ON "live_trade_events"
    FOR EACH ROW EXECUTE FUNCTION repoing_notify_market_update();
  END IF;
END $$;
