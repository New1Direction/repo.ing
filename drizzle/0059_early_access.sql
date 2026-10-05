-- Contributor early access (docs/EARLY_ACCESS.md, step 3): the market stamp, contributors' GitHub-to-wallet links and the
-- per-repository contributor snapshot. Dark: nothing writes these until EARLY_ACCESS_ENABLED=true (src/early-access.mjs).
-- Expand-only and idempotent: every object is created only if missing, so re-applying this file changes nothing, and no
-- existing row changes (every market keeps both new columns NULL: no early access).
-- All pending migrations run in one transaction, so the locks taken below are held until it commits: give up after 5s
-- (the deploy fails and can simply be retried) rather than queue every page query behind a long-running read.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- early_access_end: when the window closes (the hook's mint config holds the same time). transfer_hook_program: the hook
-- program the mint was created with. Both NULL for every market without early access.
ALTER TABLE "markets" ADD COLUMN IF NOT EXISTS "early_access_end" timestamptz;
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN IF NOT EXISTS "transfer_hook_program" varchar(44);
--> statement-breakpoint
-- Both or none; a base58 program key, never the default key; GitHub repository markets only (contributors are GitHub
-- accounts). The IS NOT NULL terms matter: a CHECK that evaluates to NULL passes, so without them half a stamp would pass.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'markets_early_access_check' AND conrelid = '"markets"'::regclass) THEN
    ALTER TABLE "markets" ADD CONSTRAINT "markets_early_access_check" CHECK (
      ("early_access_end" IS NULL AND "transfer_hook_program" IS NULL) OR
      ("early_access_end" IS NOT NULL AND "transfer_hook_program" IS NOT NULL
        AND "transfer_hook_program" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND "transfer_hook_program" <> '11111111111111111111111111111111'
        AND "github_repo_id" < 4503599627370496));
  END IF;
END $$;
--> statement-breakpoint
-- An early access market pairs with SOL only: it is never also a stock pair (0053's quote columns).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'markets_early_access_sol_only' AND conrelid = '"markets"'::regclass) THEN
    ALTER TABLE "markets" ADD CONSTRAINT "markets_early_access_sol_only" CHECK ("early_access_end" IS NULL OR
      ("quote_asset_id" IS NULL AND "quote_mint" IS NULL AND "quote_registry_version" IS NULL));
  END IF;
END $$;
--> statement-breakpoint
-- As 0053's quote stamp: a reservation that never sent a transaction (reserved, prepared or failed) may be replaced by a new
-- attempt, with or without early access and with a new window end. Once the launch transaction was sent (submitted,
-- ambiguous, confirmed) or the market is indexed, the mint exists with that hook and window, and the stamp is immutable; an
-- update that sends or indexes the launch cannot change the stamp in the same statement either.
CREATE OR REPLACE FUNCTION protect_market_early_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.status IN ('submitted', 'ambiguous', 'confirmed') OR NEW.status IN ('submitted', 'ambiguous', 'confirmed') OR
      OLD.indexed_at IS NOT NULL OR NEW.indexed_at IS NOT NULL) AND (
      NEW.early_access_end IS DISTINCT FROM OLD.early_access_end OR NEW.transfer_hook_program IS DISTINCT FROM OLD.transfer_hook_program) THEN
    RAISE EXCEPTION 'Market early access is immutable once its launch was sent';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'protect_market_early_access' AND tgrelid = '"markets"'::regclass) THEN
    CREATE TRIGGER protect_market_early_access BEFORE UPDATE ON "markets" FOR EACH ROW EXECUTE FUNCTION protect_market_early_access();
  END IF;
END $$;
--> statement-breakpoint
-- Markets whose window is (or was) open: the oracle's list upkeep reads these.
CREATE INDEX IF NOT EXISTS "markets_early_access_end_idx" ON "markets" ("early_access_end") WHERE "early_access_end" IS NOT NULL;
--> statement-breakpoint
-- One wallet per GitHub account, proven by a wallet signature (src/github-wallet-links.mjs). Keyed by GitHub's immutable user
-- id (a login can be renamed and reused). Re-linking replaces the account's wallet; a wallet linked to another account is
-- refused (UNIQUE wallet), never moved.
CREATE TABLE IF NOT EXISTS "github_wallet_links" (
  "github_user_id" bigint PRIMARY KEY NOT NULL,
  "wallet" varchar(44) NOT NULL,
  "github_login" text NOT NULL,
  "linked_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "github_wallet_links_wallet_unique" UNIQUE ("wallet"),
  CONSTRAINT "github_wallet_links_user_check" CHECK ("github_user_id" > 0),
  CONSTRAINT "github_wallet_links_wallet_check" CHECK ("wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  CONSTRAINT "github_wallet_links_login_check" CHECK ("github_login" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$')
);
--> statement-breakpoint
-- A link waiting (5 minutes) for the wallet's signature. The nonce is single use (consumed_at). Unlike
-- wallet_binding_challenges it names no repository: a link is the account's, for every repository.
CREATE TABLE IF NOT EXISTS "github_wallet_link_challenges" (
  "nonce" varchar(48) PRIMARY KEY NOT NULL,
  "github_user_id" bigint NOT NULL,
  "github_login" text NOT NULL,
  "wallet" varchar(44) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  CONSTRAINT "github_wallet_link_challenges_nonce_check" CHECK ("nonce" ~ '^[0-9a-f]{48}$'),
  CONSTRAINT "github_wallet_link_challenges_user_check" CHECK ("github_user_id" > 0),
  CONSTRAINT "github_wallet_link_challenges_wallet_check" CHECK ("wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  CONSTRAINT "github_wallet_link_challenges_login_check" CHECK ("github_login" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$'),
  CONSTRAINT "github_wallet_link_challenges_expiry_check" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '5 minutes')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_wallet_link_challenges_expiry" ON "github_wallet_link_challenges" ("expires_at");
--> statement-breakpoint
-- The repository's contributors when its early access launch is prepared (step 4 fills it): GitHub's contributor list, at
-- least one commit, bots excluded. The allow list is these accounts' linked wallets.
CREATE TABLE IF NOT EXISTS "early_access_contributors" (
  "github_repo_id" bigint NOT NULL REFERENCES "repositories"("github_repo_id"),
  "github_user_id" bigint NOT NULL,
  "github_login" text NOT NULL,
  "contributions" integer NOT NULL,
  "captured_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "early_access_contributors_pk" PRIMARY KEY ("github_repo_id", "github_user_id"),
  CONSTRAINT "early_access_contributors_github_only" CHECK ("github_repo_id" < 4503599627370496),
  CONSTRAINT "early_access_contributors_user_check" CHECK ("github_user_id" > 0),
  CONSTRAINT "early_access_contributors_contributions_check" CHECK ("contributions" >= 1)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "early_access_contributors_user" ON "early_access_contributors" ("github_user_id");
