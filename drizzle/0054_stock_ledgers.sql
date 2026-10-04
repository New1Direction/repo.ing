-- Stock-pair ledgers (docs/STOCK_QUOTES.md, "Stock ledgers"). A stock-paired market's trades, fee events, graduation, DAMM
-- fee checkpoints, fee collections, launcher payouts, and its stock's canonical pools and settlement receipts live only in
-- these stock_* tables. No SOL table, function, trigger or row changes. Amounts are raw units of each token: quote amounts are
-- the stock's raw units (its ScaledUiAmount multiplier is for display only). Fee routing is src/stock-fee-policy.mjs, and
-- every split row records the policy_version it was split under.
-- Expand-only and idempotent: every object is created only if missing, so re-applying this file changes nothing.
-- All pending migrations run in one transaction, so the locks taken below are held until it commits: give up after 5s
-- (the deploy fails and can simply be retried) rather than queue every page query behind a long-running read.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- A row that names a market (github_repo_id) and its stock (asset_id, quote_mint) must match that market's stamp (migration
-- 0053). A SOL market (no stamp), an unknown market, another stock or another mint is refused. Attached BEFORE INSERT, and
-- BEFORE UPDATE OF those three columns, to every table below that carries all three. Once stored, a row can never be re-pointed
-- to another market or stock, not even to one whose stamp it would match.
CREATE OR REPLACE FUNCTION stock_ledger_market_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "markets" m WHERE m."github_repo_id" = NEW."github_repo_id"
      AND m."quote_asset_id" = NEW."asset_id" AND m."quote_mint" = NEW."quote_mint") THEN
    RAISE EXCEPTION 'Stock ledger row does not match a stock-paired market (% for market %: % %)',
      TG_TABLE_NAME, NEW."github_repo_id", NEW."asset_id", NEW."quote_mint";
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."github_repo_id", NEW."asset_id", NEW."quote_mint")
      IS DISTINCT FROM (OLD."github_repo_id", OLD."asset_id", OLD."quote_mint") THEN
    RAISE EXCEPTION 'Stock ledger row cannot move to another market or stock (% for market %)', TG_TABLE_NAME, OLD."github_repo_id";
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- 1. The worker's position in each stock-paired pool's history (curve or graduated pool).
CREATE TABLE IF NOT EXISTS "stock_pool_cursors" (
  "pool" varchar(44) PRIMARY KEY NOT NULL,
  "github_repo_id" bigint NOT NULL,
  "venue" varchar(4) NOT NULL,
  "last_signature" varchar(88) NOT NULL,
  "last_slot" bigint NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_pool_cursors_venue_check' AND conrelid = '"stock_pool_cursors"'::regclass) THEN
    ALTER TABLE "stock_pool_cursors" ADD CONSTRAINT "stock_pool_cursors_venue_check" CHECK ("venue" IN ('dbc', 'damm'));
  END IF;
END $$;
--> statement-breakpoint
-- 2. Every swap on a stock-paired market's canonical curve or graduated pool. quote_amount is the stock in or out of the pool,
-- base_amount the market token, both raw.
CREATE TABLE IF NOT EXISTS "stock_trade_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "github_repo_id" bigint NOT NULL,
  "asset_id" varchar(32) NOT NULL,
  "quote_mint" varchar(44) NOT NULL,
  "venue" varchar(4) NOT NULL,
  "pool" varchar(44) NOT NULL,
  "signature" varchar(88) NOT NULL,
  "event_index" integer NOT NULL,
  "slot" bigint NOT NULL,
  "traded_at" timestamptz NOT NULL,
  "direction" varchar(4) NOT NULL,
  "quote_amount" bigint NOT NULL,
  "base_amount" bigint NOT NULL,
  "next_sqrt_price" varchar(40) NOT NULL,
  "trader" varchar(44) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_trade_events_chain_event_unique" ON "stock_trade_events" ("signature", "event_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_trade_events_repo_slot" ON "stock_trade_events" ("github_repo_id", "slot");
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_trade_events_venue_check' AND conrelid = '"stock_trade_events"'::regclass) THEN
    ALTER TABLE "stock_trade_events" ADD CONSTRAINT "stock_trade_events_venue_check" CHECK ("venue" IN ('dbc', 'damm'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_trade_events_direction_check' AND conrelid = '"stock_trade_events"'::regclass) THEN
    ALTER TABLE "stock_trade_events" ADD CONSTRAINT "stock_trade_events_direction_check" CHECK ("direction" IN ('buy', 'sell'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_trade_events_amounts_check' AND conrelid = '"stock_trade_events"'::regclass) THEN
    ALTER TABLE "stock_trade_events" ADD CONSTRAINT "stock_trade_events_amounts_check" CHECK ("quote_amount" >= 0 AND "base_amount" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'stock_ledger_market_check' AND tgrelid = '"stock_trade_events"'::regclass) THEN
    CREATE TRIGGER stock_ledger_market_check BEFORE INSERT OR UPDATE OF "github_repo_id", "asset_id", "quote_mint" ON "stock_trade_events"
      FOR EACH ROW EXECUTE FUNCTION stock_ledger_market_check();
  END IF;
END $$;
--> statement-breakpoint
-- 3. Each curve swap's fee, split by the policy: the creator and partner fee as the DBC charged them, and what the launcher and
-- the stock's accumulator get. DBC curve swaps only; fees of the graduated pool are stock_damm_fee_checkpoints.
CREATE TABLE IF NOT EXISTS "stock_fee_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "github_repo_id" bigint NOT NULL,
  "asset_id" varchar(32) NOT NULL,
  "quote_mint" varchar(44) NOT NULL,
  "pool" varchar(44) NOT NULL,
  "signature" varchar(88) NOT NULL,
  "event_index" integer NOT NULL,
  "slot" bigint NOT NULL,
  "creator_amount" bigint NOT NULL,
  "partner_amount" bigint NOT NULL,
  "launcher_amount" bigint NOT NULL,
  "accumulator_amount" bigint NOT NULL,
  "policy_version" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_fee_events_chain_event_unique" ON "stock_fee_events" ("signature", "event_index");
--> statement-breakpoint
-- Per-market reads (the launcher's earnings) and per-stock reads (the accumulator).
CREATE INDEX IF NOT EXISTS "stock_fee_events_repo" ON "stock_fee_events" ("github_repo_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_fee_events_asset" ON "stock_fee_events" ("asset_id");
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_fee_events_amounts_check' AND conrelid = '"stock_fee_events"'::regclass) THEN
    ALTER TABLE "stock_fee_events" ADD CONSTRAINT "stock_fee_events_amounts_check" CHECK ("creator_amount" >= 0 AND "partner_amount" >= 0
      AND "launcher_amount" >= 0 AND "accumulator_amount" >= 0);
  END IF;
  -- Every unit of the fee is routed exactly once, and the launcher's part comes out of the creator fee only.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_fee_events_split_check' AND conrelid = '"stock_fee_events"'::regclass) THEN
    ALTER TABLE "stock_fee_events" ADD CONSTRAINT "stock_fee_events_split_check" CHECK (
      "creator_amount" + "partner_amount" = "launcher_amount" + "accumulator_amount");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_fee_events_launcher_check' AND conrelid = '"stock_fee_events"'::regclass) THEN
    ALTER TABLE "stock_fee_events" ADD CONSTRAINT "stock_fee_events_launcher_check" CHECK ("launcher_amount" <= "creator_amount");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'stock_ledger_market_check' AND tgrelid = '"stock_fee_events"'::regclass) THEN
    CREATE TRIGGER stock_ledger_market_check BEFORE INSERT OR UPDATE OF "github_repo_id", "asset_id", "quote_mint" ON "stock_fee_events"
      FOR EACH ROW EXECUTE FUNCTION stock_ledger_market_check();
  END IF;
END $$;
--> statement-breakpoint
-- 4. Readings of a stock-paired curve's progress toward graduation: its stock reserve against the config's threshold.
CREATE TABLE IF NOT EXISTS "stock_graduation_observations" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "github_repo_id" bigint NOT NULL,
  "asset_id" varchar(32) NOT NULL,
  "quote_mint" varchar(44) NOT NULL,
  "pool" varchar(44) NOT NULL,
  "slot" bigint NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "quote_reserve" bigint NOT NULL,
  "migration_threshold" bigint NOT NULL,
  "is_migrated" boolean NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_graduation_observations_repo_observed" ON "stock_graduation_observations" ("github_repo_id", "observed_at");
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_graduation_observations_amounts_check' AND conrelid = '"stock_graduation_observations"'::regclass) THEN
    ALTER TABLE "stock_graduation_observations" ADD CONSTRAINT "stock_graduation_observations_amounts_check" CHECK (
      "quote_reserve" >= 0 AND "migration_threshold" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'stock_ledger_market_check' AND tgrelid = '"stock_graduation_observations"'::regclass) THEN
    CREATE TRIGGER stock_ledger_market_check BEFORE INSERT OR UPDATE OF "github_repo_id", "asset_id", "quote_mint" ON "stock_graduation_observations"
      FOR EACH ROW EXECUTE FUNCTION stock_ledger_market_check();
  END IF;
END $$;
--> statement-breakpoint
-- 5. One graduation per stock-paired market: the curve's migration into its DAMM v2 pool, and the two locked positions whose
-- fees stock_damm_fee_checkpoints follows.
CREATE TABLE IF NOT EXISTS "stock_graduation_events" (
  "github_repo_id" bigint PRIMARY KEY NOT NULL,
  "asset_id" varchar(32) NOT NULL,
  "quote_mint" varchar(44) NOT NULL,
  "dbc_pool" varchar(44) NOT NULL,
  "damm_pool" varchar(44) NOT NULL,
  "migration_signature" varchar(88) NOT NULL,
  "slot" bigint NOT NULL,
  "creator_position" varchar(44),
  "partner_position" varchar(44),
  "evidence" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'stock_ledger_market_check' AND tgrelid = '"stock_graduation_events"'::regclass) THEN
    CREATE TRIGGER stock_ledger_market_check BEFORE INSERT OR UPDATE OF "github_repo_id", "asset_id", "quote_mint" ON "stock_graduation_events"
      FOR EACH ROW EXECUTE FUNCTION stock_ledger_market_check();
  END IF;
END $$;
--> statement-breakpoint
-- 6. Cumulative fee checkpoints of the graduated pool's creator and partner positions. Each checkpoint credits the growth since
-- the last one; on the creator side the launcher's running total is floor(cumulative_earned * 150 / 497) and the rest goes to
-- the accumulator; the partner side goes to the accumulator whole.
CREATE TABLE IF NOT EXISTS "stock_damm_fee_checkpoints" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "github_repo_id" bigint NOT NULL,
  "asset_id" varchar(32) NOT NULL,
  "quote_mint" varchar(44) NOT NULL,
  "damm_pool" varchar(44) NOT NULL,
  "side" varchar(8) NOT NULL,
  "position" varchar(44) NOT NULL,
  "slot" bigint NOT NULL,
  "cumulative_earned" bigint NOT NULL,
  "cumulative_claimed" bigint NOT NULL,
  "credit" bigint NOT NULL,
  "launcher_cumulative" bigint NOT NULL,
  "launcher_credit" bigint NOT NULL,
  "accumulator_credit" bigint NOT NULL,
  "policy_version" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_damm_fee_checkpoints_pool_side_slot_unique" ON "stock_damm_fee_checkpoints" ("damm_pool", "side", "slot");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_damm_fee_checkpoints_repo" ON "stock_damm_fee_checkpoints" ("github_repo_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_damm_fee_checkpoints_asset" ON "stock_damm_fee_checkpoints" ("asset_id");
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_damm_fee_checkpoints_side_check' AND conrelid = '"stock_damm_fee_checkpoints"'::regclass) THEN
    ALTER TABLE "stock_damm_fee_checkpoints" ADD CONSTRAINT "stock_damm_fee_checkpoints_side_check" CHECK ("side" IN ('creator', 'partner'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_damm_fee_checkpoints_amounts_check' AND conrelid = '"stock_damm_fee_checkpoints"'::regclass) THEN
    ALTER TABLE "stock_damm_fee_checkpoints" ADD CONSTRAINT "stock_damm_fee_checkpoints_amounts_check" CHECK ("cumulative_earned" >= 0
      AND "cumulative_claimed" >= 0 AND "credit" >= 0 AND "launcher_cumulative" >= 0 AND "launcher_credit" >= 0 AND "accumulator_credit" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_damm_fee_checkpoints_split_check' AND conrelid = '"stock_damm_fee_checkpoints"'::regclass) THEN
    ALTER TABLE "stock_damm_fee_checkpoints" ADD CONSTRAINT "stock_damm_fee_checkpoints_split_check" CHECK (
      "credit" = "launcher_credit" + "accumulator_credit");
  END IF;
  -- The partner position never pays the launcher.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_damm_fee_checkpoints_partner_check' AND conrelid = '"stock_damm_fee_checkpoints"'::regclass) THEN
    ALTER TABLE "stock_damm_fee_checkpoints" ADD CONSTRAINT "stock_damm_fee_checkpoints_partner_check" CHECK (
      "side" <> 'partner' OR "launcher_credit" = 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'stock_ledger_market_check' AND tgrelid = '"stock_damm_fee_checkpoints"'::regclass) THEN
    CREATE TRIGGER stock_ledger_market_check BEFORE INSERT OR UPDATE OF "github_repo_id", "asset_id", "quote_mint" ON "stock_damm_fee_checkpoints"
      FOR EACH ROW EXECUTE FUNCTION stock_ledger_market_check();
  END IF;
END $$;
--> statement-breakpoint
-- 7. Claims of a stock-paired market's accrued fees from the curve or the graduated pool: the reviewed terms (and their hash),
-- the launcher's and the accumulator's parts, and once settled the amount actually received with its receipt. At most one
-- pending collection per market and source.
CREATE TABLE IF NOT EXISTS "stock_fee_collections" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "github_repo_id" bigint NOT NULL,
  "asset_id" varchar(32) NOT NULL,
  "quote_mint" varchar(44) NOT NULL,
  "source" varchar(16) NOT NULL,
  "reviewed_amount" bigint NOT NULL,
  "actual_amount" bigint,
  "launcher_amount" bigint NOT NULL,
  "accumulator_amount" bigint NOT NULL,
  "terms_hash" varchar(64) NOT NULL,
  "status" varchar(10) NOT NULL,
  "signature" varchar(88),
  "signed_transaction" text,
  "receipt" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "settled_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_fee_collections_one_pending" ON "stock_fee_collections" ("github_repo_id", "source") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_fee_collections_asset_status" ON "stock_fee_collections" ("asset_id", "status");
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_fee_collections_source_check' AND conrelid = '"stock_fee_collections"'::regclass) THEN
    ALTER TABLE "stock_fee_collections" ADD CONSTRAINT "stock_fee_collections_source_check" CHECK (
      "source" IN ('dbc_creator', 'dbc_partner', 'damm_creator', 'damm_partner'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_fee_collections_status_check' AND conrelid = '"stock_fee_collections"'::regclass) THEN
    ALTER TABLE "stock_fee_collections" ADD CONSTRAINT "stock_fee_collections_status_check" CHECK ("status" IN ('pending', 'settled', 'aborted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_fee_collections_amounts_check' AND conrelid = '"stock_fee_collections"'::regclass) THEN
    ALTER TABLE "stock_fee_collections" ADD CONSTRAINT "stock_fee_collections_amounts_check" CHECK ("reviewed_amount" >= 0
      AND ("actual_amount" IS NULL OR "actual_amount" >= 0) AND "launcher_amount" >= 0 AND "accumulator_amount" >= 0);
  END IF;
  -- A settled collection carries its signature, settlement time, the amount actually received and its receipt; a pending one
  -- has no settlement time. An aborted one may never have been signed.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_fee_collections_settlement_check' AND conrelid = '"stock_fee_collections"'::regclass) THEN
    ALTER TABLE "stock_fee_collections" ADD CONSTRAINT "stock_fee_collections_settlement_check" CHECK (
      ("status" <> 'settled' OR ("signature" IS NOT NULL AND "settled_at" IS NOT NULL AND "actual_amount" IS NOT NULL AND "receipt" IS NOT NULL))
      AND ("status" <> 'pending' OR "settled_at" IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'stock_ledger_market_check' AND tgrelid = '"stock_fee_collections"'::regclass) THEN
    CREATE TRIGGER stock_ledger_market_check BEFORE INSERT OR UPDATE OF "github_repo_id", "asset_id", "quote_mint" ON "stock_fee_collections"
      FOR EACH ROW EXECUTE FUNCTION stock_ledger_market_check();
  END IF;
END $$;
--> statement-breakpoint
-- 8. Payouts of the launcher's share, in the stock, to the market's launcher wallet only. At most one pending payout per market.
CREATE TABLE IF NOT EXISTS "stock_launcher_payouts" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "github_repo_id" bigint NOT NULL,
  "asset_id" varchar(32) NOT NULL,
  "quote_mint" varchar(44) NOT NULL,
  "wallet" varchar(44) NOT NULL,
  "amount" bigint NOT NULL,
  "status" varchar(10) NOT NULL,
  "signature" varchar(88),
  "signed_transaction" text,
  "receipt" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "settled_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_launcher_payouts_one_pending" ON "stock_launcher_payouts" ("github_repo_id") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_launcher_payouts_repo_status" ON "stock_launcher_payouts" ("github_repo_id", "status");
--> statement-breakpoint
-- The payout wallet is the market's launcher wallet, on insert and on any later change of the market or the wallet.
CREATE OR REPLACE FUNCTION stock_launcher_payout_wallet_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "markets" m WHERE m."github_repo_id" = NEW."github_repo_id" AND m."launcher_wallet" = NEW."wallet") THEN
    RAISE EXCEPTION 'Stock launcher payout wallet is not the market''s launcher wallet (market %: %)', NEW."github_repo_id", NEW."wallet";
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_launcher_payouts_amount_check' AND conrelid = '"stock_launcher_payouts"'::regclass) THEN
    ALTER TABLE "stock_launcher_payouts" ADD CONSTRAINT "stock_launcher_payouts_amount_check" CHECK ("amount" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_launcher_payouts_status_check' AND conrelid = '"stock_launcher_payouts"'::regclass) THEN
    ALTER TABLE "stock_launcher_payouts" ADD CONSTRAINT "stock_launcher_payouts_status_check" CHECK ("status" IN ('pending', 'settled', 'aborted'));
  END IF;
  -- A settled payout carries its signature, settlement time and receipt; a pending one has no settlement time. An aborted one
  -- may never have been signed.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_launcher_payouts_settlement_check' AND conrelid = '"stock_launcher_payouts"'::regclass) THEN
    ALTER TABLE "stock_launcher_payouts" ADD CONSTRAINT "stock_launcher_payouts_settlement_check" CHECK (
      ("status" <> 'settled' OR ("signature" IS NOT NULL AND "settled_at" IS NOT NULL AND "receipt" IS NOT NULL))
      AND ("status" <> 'pending' OR "settled_at" IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'stock_ledger_market_check' AND tgrelid = '"stock_launcher_payouts"'::regclass) THEN
    CREATE TRIGGER stock_ledger_market_check BEFORE INSERT OR UPDATE OF "github_repo_id", "asset_id", "quote_mint" ON "stock_launcher_payouts"
      FOR EACH ROW EXECUTE FUNCTION stock_ledger_market_check();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'stock_launcher_payout_wallet_check' AND tgrelid = '"stock_launcher_payouts"'::regclass) THEN
    CREATE TRIGGER stock_launcher_payout_wallet_check BEFORE INSERT OR UPDATE OF "github_repo_id", "wallet" ON "stock_launcher_payouts"
      FOR EACH ROW EXECUTE FUNCTION stock_launcher_payout_wallet_check();
  END IF;
END $$;
--> statement-breakpoint
-- 9. The canonical REPOING/stock pool of each stock, which the owner seeds later from the accumulated fees. Pools are per
-- stock, not per market, so this table has no market check. At most one active pool per stock.
CREATE TABLE IF NOT EXISTS "stock_canonical_pools" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "asset_id" varchar(32) NOT NULL,
  "quote_mint" varchar(44) NOT NULL,
  "pool" varchar(44) NOT NULL,
  "repoing_mint" varchar(44) NOT NULL,
  "position" varchar(44),
  "evidence" jsonb NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "registered_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_canonical_pools_one_active" ON "stock_canonical_pools" ("asset_id") WHERE "active";
--> statement-breakpoint
-- 10. Verified receipts of the owner's settlements of a stock's accumulator (a swap into REPOING, adding liquidity, seeding).
CREATE TABLE IF NOT EXISTS "stock_settlement_receipts" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "asset_id" varchar(32) NOT NULL,
  "quote_mint" varchar(44) NOT NULL,
  "kind" varchar(16) NOT NULL,
  "signature" varchar(88) NOT NULL,
  "quote_spent" bigint NOT NULL,
  "repoing_spent" bigint NOT NULL,
  "repoing_received" bigint NOT NULL,
  "evidence" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_settlement_receipts_signature_unique" ON "stock_settlement_receipts" ("signature");
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_settlement_receipts_kind_check' AND conrelid = '"stock_settlement_receipts"'::regclass) THEN
    ALTER TABLE "stock_settlement_receipts" ADD CONSTRAINT "stock_settlement_receipts_kind_check" CHECK ("kind" IN ('swap', 'add_liquidity', 'seed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_settlement_receipts_amounts_check' AND conrelid = '"stock_settlement_receipts"'::regclass) THEN
    ALTER TABLE "stock_settlement_receipts" ADD CONSTRAINT "stock_settlement_receipts_amounts_check" CHECK ("quote_spent" >= 0
      AND "repoing_spent" >= 0 AND "repoing_received" >= 0);
  END IF;
END $$;
--> statement-breakpoint
-- 11. Live updates for stock-paired markets on a channel of their own, modelled on 0023's repoing_notify_market_update (left
-- unchanged): invalidation hints only, delivered by Postgres after the inserting transaction commits, and only for a canonical
-- market. The payload is the market's mint and the kind of row ('trade' or 'fee'); no amount, price, signature or private data
-- travels through this channel.
CREATE OR REPLACE FUNCTION repoing_notify_stock_market_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  canonical_mint text;
BEGIN
  SELECT mint INTO canonical_mint FROM markets WHERE github_repo_id = NEW.github_repo_id
    AND status = 'confirmed' AND indexed_at IS NOT NULL AND launch_finality = 'finalized';
  IF canonical_mint IS NOT NULL THEN
    PERFORM pg_notify('repoing_stock_market_updates', json_build_object('mint', canonical_mint,
      'kind', CASE WHEN TG_TABLE_NAME = 'stock_fee_events' THEN 'fee' ELSE 'trade' END)::text);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'repoing_stock_trade_update' AND tgrelid = '"stock_trade_events"'::regclass) THEN
    CREATE TRIGGER repoing_stock_trade_update AFTER INSERT ON "stock_trade_events" FOR EACH ROW EXECUTE FUNCTION repoing_notify_stock_market_update();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'repoing_stock_fee_update' AND tgrelid = '"stock_fee_events"'::regclass) THEN
    CREATE TRIGGER repoing_stock_fee_update AFTER INSERT ON "stock_fee_events" FOR EACH ROW EXECUTE FUNCTION repoing_notify_stock_market_update();
  END IF;
END $$;
