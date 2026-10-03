-- Market quote asset (docs/STOCK_QUOTES.md). Expand-only and idempotent: every object is created only if missing, so
-- re-applying this file changes nothing, and no existing row changes.
-- A SOL market keeps all three columns NULL: SOL has exactly one representation, so every existing row and every SOL code
-- path reads exactly as before. A market paired with an approved tokenized stock stamps, when its launch is reserved, the
-- registry's asset id, that asset's exact mint and the registry version (src/quote-assets.mjs). The quote mint is never
-- resolved again after launch: once the launch transaction has been sent the stamp can never change.
-- All pending migrations run in one transaction, so the locks taken below are held until it commits: give up after 5s
-- (the deploy fails and can simply be retried) rather than queue every page query behind a long-running read.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN IF NOT EXISTS "quote_asset_id" varchar(32);
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN IF NOT EXISTS "quote_mint" varchar(44);
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN IF NOT EXISTS "quote_registry_version" integer;
--> statement-breakpoint
-- All three or none; never an explicit SOL stamp; GitHub repository markets only (company mappings are GitHub owners).
-- The IS NOT NULL terms matter: a CHECK that evaluates to NULL passes, so without them a partial stamp would be accepted.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'markets_quote_asset_check' AND conrelid = '"markets"'::regclass) THEN
    ALTER TABLE "markets" ADD CONSTRAINT "markets_quote_asset_check" CHECK (
      ("quote_asset_id" IS NULL AND "quote_mint" IS NULL AND "quote_registry_version" IS NULL) OR
      ("quote_asset_id" IS NOT NULL AND "quote_mint" IS NOT NULL AND "quote_registry_version" IS NOT NULL
        AND "quote_asset_id" ~ '^[a-z0-9][a-z0-9-]{1,31}$' AND "quote_asset_id" <> 'sol'
        AND "quote_mint" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND "quote_mint" <> 'So11111111111111111111111111111111111111112'
        AND "quote_registry_version" >= 1 AND "github_repo_id" < 4503599627370496));
  END IF;
END $$;
--> statement-breakpoint
-- A reservation that never sent a transaction (reserved, prepared or failed) may be replaced by a new attempt with another
-- pair. Once the launch transaction was sent (submitted, ambiguous, confirmed) or the market is indexed, its pool was
-- created against that quote mint, and the stamp is immutable.
CREATE OR REPLACE FUNCTION protect_market_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.status IN ('submitted', 'ambiguous', 'confirmed') OR OLD.indexed_at IS NOT NULL) AND (
      NEW.quote_asset_id IS DISTINCT FROM OLD.quote_asset_id OR NEW.quote_mint IS DISTINCT FROM OLD.quote_mint OR
      NEW.quote_registry_version IS DISTINCT FROM OLD.quote_registry_version) THEN
    RAISE EXCEPTION 'Market quote asset is immutable once its launch was sent';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'protect_market_quote' AND tgrelid = '"markets"'::regclass) THEN
    CREATE TRIGGER protect_market_quote BEFORE UPDATE ON "markets" FOR EACH ROW EXECUTE FUNCTION protect_market_quote();
  END IF;
END $$;
--> statement-breakpoint
-- Stock-paired markets per asset (the protocol accumulator and "N repos contributing" read by asset).
CREATE INDEX IF NOT EXISTS "markets_quote_asset_idx" ON "markets" ("quote_asset_id") WHERE "quote_asset_id" IS NOT NULL;
