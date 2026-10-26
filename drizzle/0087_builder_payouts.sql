-- Expand-only. Builder payouts from the capped payout wallet (owner rules, 2026-10-26; src/builder-payouts.mjs).
SET LOCAL lock_timeout = '5s';
-- The payouts switch and its caps, flipped with one UPDATE. No row, or enabled false, means no payout is built.
CREATE TABLE IF NOT EXISTS claim_controls (
  key varchar(32) PRIMARY KEY CHECK (key IN ('builder_payouts')),
  enabled boolean NOT NULL DEFAULT false,
  -- A claim can never exceed the payout wallet's 2 SOL cap; a day never exceeds five refills.
  max_claim_lamports bigint NOT NULL CHECK (max_claim_lamports > 0 AND max_claim_lamports <= 2000000000),
  daily_lamports bigint NOT NULL CHECK (daily_lamports >= max_claim_lamports AND daily_lamports <= 10000000000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
);
--> statement-breakpoint
INSERT INTO claim_controls (key, enabled, max_claim_lamports, daily_lamports, updated_by)
VALUES ('builder_payouts', false, 500000000, 2000000000, 'migration 0087') ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- Claims open one repository at a time. opened_at starts the 12-month unclaimed window. The paused repositories never open.
CREATE TABLE IF NOT EXISTS repo_claim_windows (
  github_repo_id bigint PRIMARY KEY REFERENCES repositories(github_repo_id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  opened_by text NOT NULL,
  CHECK (github_repo_id NOT IN (1250276806, 1332056763))
);
--> statement-breakpoint
-- One-use claim challenges: the payout wallet signs repo ID + wallet + nonce. A nonce and a signature are each used once.
CREATE TABLE IF NOT EXISTS claim_payout_challenges (
  nonce varchar(48) PRIMARY KEY CHECK (nonce ~ '^[0-9a-f]{48}$'),
  github_repo_id bigint NOT NULL REFERENCES repositories(github_repo_id),
  github_user_id bigint NOT NULL CHECK (github_user_id > 0),
  wallet varchar(44) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  signature varchar(88) UNIQUE,
  CHECK ((consumed_at IS NULL) = (signature IS NULL))
);
--> statement-breakpoint
ALTER TABLE repo_claims ADD COLUMN IF NOT EXISTS payout_source text NOT NULL DEFAULT 'meteora-pool'
  CHECK (payout_source IN ('meteora-pool', 'payout-wallet'));
--> statement-breakpoint
ALTER TABLE repo_claims ADD COLUMN IF NOT EXISTS payout_nonce varchar(48) UNIQUE REFERENCES claim_payout_challenges(nonce);
--> statement-breakpoint
-- A payout-wallet row is a native SOL transfer with its nonce, and keeps its signed transfer while pending.
ALTER TABLE repo_claims ADD CONSTRAINT repo_claims_payout_wallet_nonce CHECK (
  (payout_source = 'payout-wallet') = (payout_nonce IS NOT NULL)
  AND (payout_source <> 'payout-wallet' OR (asset = 'So11111111111111111111111111111111111111112'
    AND damm_amount_base_units = 0 AND evidence_source = 'signed-intent'
    AND (status <> 'pending' OR signed_transaction IS NOT NULL)))) NOT VALID;
--> statement-breakpoint
ALTER TABLE repo_claims VALIDATE CONSTRAINT repo_claims_payout_wallet_nonce;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS repo_claims_payout_wallet_recent ON repo_claims (created_at)
  WHERE payout_source = 'payout-wallet' AND status IN ('pending', 'settled');
--> statement-breakpoint
-- A payout wallet change takes effect after 24 hours (was 48). Existing requests already satisfy the lower floor.
ALTER TABLE payout_address_requests DROP CONSTRAINT payout_address_requests_hold_check;
--> statement-breakpoint
ALTER TABLE payout_address_requests ADD CONSTRAINT payout_address_requests_hold_check
  CHECK (active_at >= requested_at + interval '24 hours') NOT VALID;
--> statement-breakpoint
ALTER TABLE payout_address_requests VALIDATE CONSTRAINT payout_address_requests_hold_check;
--> statement-breakpoint
-- 0051's insert guard with the 24-hour floor.
CREATE OR REPLACE FUNCTION start_payout_address_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'pending' OR NEW."resolved_at" IS NOT NULL OR NEW."resolved_by_github_user_id" IS NOT NULL
      OR NEW."resolved_by_subject" IS NOT NULL OR NEW."resolution_reason" IS NOT NULL THEN
    RAISE EXCEPTION 'A payout address request starts pending';
  END IF;
  NEW."requested_at" := clock_timestamp();
  NEW."active_at" := greatest(NEW."active_at", NEW."requested_at" + interval '24 hours');
  NEW."replaces_bound_at" := (SELECT b."bound_at" FROM "repo_beneficiaries" b WHERE b."github_repo_id" = NEW."github_repo_id");
  RETURN NEW;
END $$;
