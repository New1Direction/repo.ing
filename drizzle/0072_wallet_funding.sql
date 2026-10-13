-- Where each trading wallet's first SOL came from (src/wallet-funding.mjs, docs/LAUNCH_TRANSPARENCY.md#linked-wallets): the first
-- system transfer into the wallet in its oldest transaction. Wallets sharing a funder (that funded few wallets, so not an exchange or
-- other service), or funded by another trading wallet, are linked as one controller for trading integrity and incentives.
-- Public chain facts only. Expand-only and idempotent.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_funding" (
  "wallet" varchar(44) PRIMARY KEY CHECK ("wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  "status" varchar(16) NOT NULL CHECK ("status" IN ('found', 'none', 'long-history', 'error')),
  "funder" varchar(44) CHECK ("funder" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  "funding_signature" varchar(88),
  "funded_lamports" numeric(20, 0) CHECK ("funded_lamports" >= 0),
  "funded_at" timestamptz,
  "funder_busy" boolean,
  "checked_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "wallet_funding_found_check" CHECK (("status" = 'found') = ("funder" IS NOT NULL AND "funding_signature" IS NOT NULL)),
  CONSTRAINT "wallet_funding_not_self" CHECK ("funder" IS NULL OR "funder" <> "wallet")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_funding_funder" ON "wallet_funding"("funder") WHERE "status" = 'found';
