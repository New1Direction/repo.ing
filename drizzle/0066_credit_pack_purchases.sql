-- AI credit packs on repo.ing/credits (src/credits-packs.mjs): one row per pack bought from the repo.ing AI credits service.
-- The retry key is stored before the quote is asked for, with a hash of the credit service session that asks (the service
-- keeps retry keys per session), so a quote whose answer was lost is asked for again under the same key and session. Then, as for "Claim as AI credits" (0065): the transfer repo.ing prepared (its message), the signature before
-- it broadcasts, and the outcome with the pack's spin. One open purchase per GitHub account. Expand-only and idempotent.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_pack_purchases" (
  "id" bigserial PRIMARY KEY,
  "github_user_id" bigint NOT NULL,
  "github_login" varchar(39) NOT NULL,
  "pack_micro" bigint NOT NULL,
  "idempotency_key" varchar(32) NOT NULL UNIQUE,
  "session_hash" char(64) NOT NULL,
  "network" varchar(16) NOT NULL,
  "status" varchar(16) NOT NULL,
  "quote_id" uuid UNIQUE,
  "lamports" bigint,
  "price_micro_per_sol" bigint,
  "reference" varchar(44),
  "expires_at" timestamp with time zone,
  "payer_wallet" varchar(44),
  "prepared_message" text,
  "last_valid_block_height" bigint,
  "payment_signature" varchar(88) UNIQUE,
  "earlier_signatures" text[] NOT NULL DEFAULT '{}',
  "spin_id" uuid UNIQUE,
  "multiplier_bps" integer,
  "bonus_micro" bigint,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "submitted_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "credit_pack_purchases_ids_check" CHECK ("github_user_id" > 0),
  CONSTRAINT "credit_pack_purchases_pack_check" CHECK ("pack_micro" IN (10000000, 25000000, 50000000, 100000000)),
  CONSTRAINT "credit_pack_purchases_network_check" CHECK ("network" IN ('mainnet', 'devnet')),
  CONSTRAINT "credit_pack_purchases_status_check" CHECK ("status" IN ('requested', 'quoted', 'prepared', 'submitted', 'credited', 'review', 'expired', 'cancelled', 'failed')),
  CONSTRAINT "credit_pack_purchases_quote_check" CHECK (("quote_id" IS NULL AND "lamports" IS NULL AND "price_micro_per_sol" IS NULL AND "reference" IS NULL
      AND "expires_at" IS NULL AND "status" IN ('requested', 'failed', 'cancelled'))
    OR ("quote_id" IS NOT NULL AND "lamports" BETWEEN 10000000 AND 100000000000 AND "price_micro_per_sol" > 0 AND "reference" IS NOT NULL
      AND "expires_at" IS NOT NULL AND "status" <> 'requested')),
  CONSTRAINT "credit_pack_purchases_payment_check" CHECK (("status" <> 'submitted' OR "payment_signature" IS NOT NULL)
    AND ("status" NOT IN ('prepared', 'submitted') OR ("payer_wallet" IS NOT NULL AND "prepared_message" IS NOT NULL AND "last_valid_block_height" IS NOT NULL))),
  CONSTRAINT "credit_pack_purchases_spin_check" CHECK (("status" = 'credited') = ("spin_id" IS NOT NULL)
    AND ("spin_id" IS NULL) = ("multiplier_bps" IS NULL) AND ("spin_id" IS NULL) = ("bonus_micro" IS NULL)
    AND ("multiplier_bps" IS NULL OR ("multiplier_bps" IN (10000, 12000, 20000, 50000) AND "bonus_micro" = "pack_micro" * ("multiplier_bps" - 10000) / 10000)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_pack_purchases_one_open" ON "credit_pack_purchases" ("github_user_id") WHERE "status" IN ('requested', 'quoted', 'prepared', 'submitted');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_pack_purchases_by_user" ON "credit_pack_purchases" ("github_user_id", "id");
