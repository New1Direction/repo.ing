-- Verification bonus (docs/VERIFICATION_BONUS.md): a launcher earns a one-time bonus, paid by the platform's protected
-- partner signer from platform revenue, when the repository's maintainer first verifies within 30 days of launch.
-- Additive and idempotent: every object is created only if it is missing, so re-applying this file changes nothing.
-- Existing markets are never enrolled: the server stamps verification_bonus_lamports when it reserves a NEW launch
-- (VERIFICATION_BONUS_LAMPORTS), and that stamp, not the current environment, is the market's policy.
ALTER TABLE "markets" ADD COLUMN IF NOT EXISTS "verification_bonus_lamports" bigint;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'markets_verification_bonus_lamports_check'
      AND conrelid = '"markets"'::regclass) THEN
    ALTER TABLE "markets" ADD CONSTRAINT "markets_verification_bonus_lamports_check" CHECK (
      "verification_bonus_lamports" IS NULL OR "verification_bonus_lamports" BETWEEN 1000000 AND 1000000000);
  END IF;
END $$;
--> statement-breakpoint
-- Like discovery_version (protect_indexed_discoverer, 0017): once a launch is indexed its bonus stamp can never be
-- added, changed or removed, so no market is enrolled retroactively and no stamped promise is withdrawn.
CREATE OR REPLACE FUNCTION protect_indexed_verification_bonus() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.indexed_at IS NOT NULL AND NEW.verification_bonus_lamports IS DISTINCT FROM OLD.verification_bonus_lamports THEN
    RAISE EXCEPTION 'Indexed verification bonus policy is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'protect_indexed_verification_bonus' AND tgrelid = '"markets"'::regclass) THEN
    CREATE TRIGGER protect_indexed_verification_bonus BEFORE UPDATE ON "markets" FOR EACH ROW
      EXECUTE FUNCTION protect_indexed_verification_bonus();
  END IF;
END $$;
--> statement-breakpoint
-- At most one bonus per market (primary key), created by the worker's accrual pass from the repository's FIRST admin
-- verification. 'ineligible' rows record the failed rules so operators and the launcher can see why. Eligible rows
-- wait in 'pending_review' for an operator; 'paid' is only ever set together with a settled payout below. The approval
-- is kept even if an approved bonus is rejected later.
CREATE TABLE IF NOT EXISTS "verification_bonuses" (
  "github_repo_id" bigint PRIMARY KEY NOT NULL REFERENCES "markets"("github_repo_id"),
  "status" varchar(16) NOT NULL,
  "amount" bigint NOT NULL,
  "launcher_wallet" varchar(44) NOT NULL,
  "verification_id" integer NOT NULL REFERENCES "repo_verifications"("id"),
  "verifier_github_user_id" bigint NOT NULL,
  "verifier_login" text NOT NULL,
  "verified_at" timestamptz NOT NULL,
  "activated_at" timestamptz NOT NULL,
  "evidence" jsonb NOT NULL,
  "reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "reviewed_at" timestamptz,
  "reviewer_github_user_id" bigint,
  "reviewer_login" text,
  "approved_at" timestamptz,
  "approver_github_user_id" bigint,
  "approver_login" text,
  "paid_at" timestamptz,
  CONSTRAINT "verification_bonuses_status_check" CHECK ("status" IN ('pending_review', 'ineligible', 'approved', 'rejected', 'paid')),
  CONSTRAINT "verification_bonuses_amount_check" CHECK ("amount" BETWEEN 1000000 AND 1000000000),
  CONSTRAINT "verification_bonuses_reason_check" CHECK (("status" IN ('ineligible', 'rejected')) = ("reason" IS NOT NULL)),
  CONSTRAINT "verification_bonuses_review_check" CHECK (
    ("status" IN ('approved', 'rejected', 'paid')) = ("reviewed_at" IS NOT NULL AND "reviewer_github_user_id" IS NOT NULL)),
  CONSTRAINT "verification_bonuses_paid_check" CHECK (("status" = 'paid') = ("paid_at" IS NOT NULL)),
  CONSTRAINT "verification_bonuses_approval_check" CHECK (
    ("status" NOT IN ('approved', 'paid') OR ("approved_at" IS NOT NULL AND "approver_github_user_id" IS NOT NULL)) AND
    ("status" NOT IN ('pending_review', 'ineligible') OR ("approved_at" IS NULL AND "approver_github_user_id" IS NULL)))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_bonuses_launcher" ON "verification_bonuses" ("launcher_wallet");
--> statement-breakpoint
-- Durable payout intents. The fully signed transfer (partner -> launcher, plus a memo naming the idempotency key) is
-- stored as 'pending' BEFORE its first broadcast; recovery only rebroadcasts these exact bytes. A partial unique index
-- allows one live or settled payout per bonus, so a bonus can never be paid twice; an attempt is 'aborted' only after
-- a finalized failure or provable blockhash expiry with no transaction in finalized history.
CREATE TABLE IF NOT EXISTS "verification_bonus_payouts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "github_repo_id" bigint NOT NULL REFERENCES "verification_bonuses"("github_repo_id"),
  "attempt" integer NOT NULL,
  "idempotency_key" varchar(80) NOT NULL,
  "wallet" varchar(44) NOT NULL,
  "payer" varchar(44) NOT NULL,
  "amount" bigint NOT NULL,
  "memo" text NOT NULL,
  "status" varchar(16) NOT NULL,
  "signature" varchar(88) NOT NULL,
  "signed_transaction" text NOT NULL,
  "last_valid_block_height" bigint NOT NULL,
  "network_fee" bigint,
  "slot" bigint,
  "created_by" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "settled_at" timestamptz,
  "resolved_at" timestamptz,
  "resolution_reason" text,
  CONSTRAINT "verification_bonus_payouts_status_check" CHECK ("status" IN ('pending', 'settled', 'aborted')),
  CONSTRAINT "verification_bonus_payouts_amount_check" CHECK ("amount" BETWEEN 1000000 AND 1000000000),
  CONSTRAINT "verification_bonus_payouts_attempt_check" CHECK ("attempt" > 0),
  CONSTRAINT "verification_bonus_payouts_wallets_check" CHECK ("wallet" <> "payer"),
  CONSTRAINT "verification_bonus_payouts_state_check" CHECK (
    ("status" = 'pending' AND "settled_at" IS NULL AND "resolved_at" IS NULL AND "resolution_reason" IS NULL AND "network_fee" IS NULL) OR
    ("status" = 'settled' AND "settled_at" IS NOT NULL AND "network_fee" IS NOT NULL AND "slot" IS NOT NULL
      AND "resolved_at" IS NULL AND "resolution_reason" IS NULL) OR
    ("status" = 'aborted' AND "settled_at" IS NULL AND "resolved_at" IS NOT NULL AND "resolution_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verification_bonus_payouts_signature_unique" ON "verification_bonus_payouts" ("signature");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verification_bonus_payouts_idempotency_unique" ON "verification_bonus_payouts" ("idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verification_bonus_payouts_one_live" ON "verification_bonus_payouts" ("github_repo_id")
  WHERE "status" IN ('pending', 'settled');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verification_bonus_payouts_status" ON "verification_bonus_payouts" ("status", "created_at");
