-- Free referral payout setups (src/referral-sponsorship.mjs): repo.ing's partner wallet creates a wallet's wrapped-SOL
-- payout account after the wallet signs a plain-text message. One row per signed attempt, with the fully signed
-- transaction stored before any broadcast; at most one pending or settled row per wallet, and a settled one is final.
-- Expand-only and idempotent.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_sponsorships" (
  "id" uuid PRIMARY KEY,
  "wallet" varchar(44) NOT NULL,
  "status" varchar(16) NOT NULL,
  "auth_message" text NOT NULL,
  "auth_expires_at" timestamp with time zone NOT NULL,
  "transaction" text NOT NULL,
  "signature" varchar(88) NOT NULL UNIQUE,
  "last_valid_block_height" bigint NOT NULL,
  "rent_lamports" bigint,
  "fee_lamports" bigint,
  "resolution_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "settled_at" timestamp with time zone,
  CONSTRAINT "referral_sponsorships_status_check" CHECK ("status" IN ('pending', 'settled', 'aborted')),
  CONSTRAINT "referral_sponsorships_wallet_check" CHECK ("wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "referral_sponsorships_one_per_wallet" ON "referral_sponsorships" ("wallet")
  WHERE "status" IN ('pending', 'settled');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_sponsorships_created_idx" ON "referral_sponsorships" ("created_at");
