-- Bundle launches (docs/BUNDLE_LAUNCH.md): the market stamp and the bundles the site opened. Dark: nothing writes these until
-- Bundle launches are switched on (src/bundle-launch.mjs). Expand-only and idempotent: every object is created only if missing,
-- so re-applying this file changes nothing, and no existing row changes (every market keeps bundle_id NULL: no bundle).
-- All pending migrations run in one transaction, so the locks taken below are held until it commits: give up after 5s
-- (the deploy fails and can simply be retried) rather than queue every page query behind a long-running read.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- bundle_id: the bundle program's Bundle id the market was launched from (its vault holds the first buy, its router claims the
-- partner fees). NULL for every other market.
ALTER TABLE "markets" ADD COLUMN IF NOT EXISTS "bundle_id" bigint;
--> statement-breakpoint
-- A bundle market pairs with SOL, on GitHub, without early access; one market per bundle.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'markets_bundle_check' AND conrelid = '"markets"'::regclass) THEN
    ALTER TABLE "markets" ADD CONSTRAINT "markets_bundle_check" CHECK ("bundle_id" IS NULL OR ("bundle_id" > 0
      AND "quote_asset_id" IS NULL AND "quote_mint" IS NULL AND "quote_registry_version" IS NULL
      AND "early_access_end" IS NULL AND "transfer_hook_program" IS NULL AND "github_repo_id" < 4503599627370496));
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "markets_bundle_id_unique" ON "markets" ("bundle_id") WHERE "bundle_id" IS NOT NULL;
--> statement-breakpoint
-- As 0059's early access stamp: a reservation that never sent a transaction may be replaced; once the launch transaction was
-- sent or the market is indexed, the mint's pool is on the bundle config with that vault, and the stamp is immutable.
CREATE OR REPLACE FUNCTION protect_market_bundle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.status IN ('submitted', 'ambiguous', 'confirmed') OR NEW.status IN ('submitted', 'ambiguous', 'confirmed') OR
      OLD.indexed_at IS NOT NULL OR NEW.indexed_at IS NOT NULL) AND NEW.bundle_id IS DISTINCT FROM OLD.bundle_id THEN
    RAISE EXCEPTION 'Market bundle is immutable once its launch was sent';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'protect_market_bundle' AND tgrelid = '"markets"'::regclass) THEN
    CREATE TRIGGER protect_market_bundle BEFORE UPDATE ON "markets" FOR EACH ROW EXECUTE FUNCTION protect_market_bundle();
  END IF;
END $$;
--> statement-breakpoint
-- The bundles the site opened (one row per on-chain Bundle account): the chain holds the raise, the deposits and the vault;
-- this row ties the bundle to its repository and tracks the site's own steps (opening, launching).
CREATE TABLE IF NOT EXISTS "bundles" (
  "bundle_id" bigint PRIMARY KEY NOT NULL,
  "github_repo_id" bigint NOT NULL REFERENCES "repositories"("github_repo_id"),
  "address" varchar(44) NOT NULL UNIQUE,
  "creator_wallet" varchar(44) NOT NULL,
  -- The token the launch will create, chosen when the bundle was opened (the launch happens later, server-signed).
  "token_name" text NOT NULL,
  "token_symbol" varchar(16) NOT NULL,
  "token_image" text,
  "target_lamports" numeric(20, 0) NOT NULL,
  "min_deposit_lamports" numeric(20, 0) NOT NULL,
  "deadline" timestamptz NOT NULL,
  -- opening: create transaction prepared, not seen on chain yet; raising; launching: the launch transaction was sent;
  -- launched: the market row exists; failed: the raise failed or was cancelled (refunds open on chain); expired: never opened.
  "status" varchar(16) DEFAULT 'opening' NOT NULL,
  "create_signature" varchar(88),
  "launch_signature" varchar(88),
  -- The launch's mint (its secret stays sealed in the launch session, never here) and the last launch error, for operators.
  "launch_mint" varchar(44),
  "launch_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "bundles_id_check" CHECK ("bundle_id" > 0),
  CONSTRAINT "bundles_status_check" CHECK ("status" IN ('opening', 'raising', 'launching', 'launched', 'failed', 'expired')),
  CONSTRAINT "bundles_amounts_check" CHECK ("target_lamports" > 0 AND "min_deposit_lamports" > 0 AND "min_deposit_lamports" <= "target_lamports")
);
--> statement-breakpoint
-- Bundle ids: the program's Bundle PDA is seeded with the id, and only repo.ing's admin co-signs create_bundle, so this sequence
-- is the one source of ids.
CREATE SEQUENCE IF NOT EXISTS "bundle_id_seq" START WITH 1;
--> statement-breakpoint
-- One live bundle per repository (a repository has one market for ever; a failed or expired bundle frees it).
CREATE UNIQUE INDEX IF NOT EXISTS "bundles_one_live_per_repo" ON "bundles" ("github_repo_id")
  WHERE "status" IN ('opening', 'raising', 'launching', 'launched');
