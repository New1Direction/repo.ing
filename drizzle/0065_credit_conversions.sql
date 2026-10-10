-- "Claim as AI credits" on the claim page (src/credits-web.mjs): one row per quote from the repo.ing AI credits service.
-- The builder pays the quote from their own wallet with one approval; repo.ing keeps the transfer it prepared (its
-- message), the signature before it broadcasts, and the outcome the credit service reports. One open conversion per GitHub
-- account. Expand-only and idempotent.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_conversions" (
  "id" bigserial PRIMARY KEY,
  "github_repo_id" bigint NOT NULL,
  "github_user_id" bigint NOT NULL,
  "github_login" varchar(39) NOT NULL,
  "quote_id" uuid NOT NULL UNIQUE,
  "lamports" bigint NOT NULL,
  "credit_micro" bigint NOT NULL,
  "price_micro_per_sol" bigint NOT NULL,
  "reference" varchar(44) NOT NULL,
  "network" varchar(16) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "status" varchar(16) NOT NULL,
  "payer_wallet" varchar(44),
  "prepared_message" text,
  "last_valid_block_height" bigint,
  "payment_signature" varchar(88) UNIQUE,
  "earlier_signatures" text[] NOT NULL DEFAULT '{}',
  "credited_micro" bigint,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "submitted_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "credit_conversions_ids_check" CHECK ("github_repo_id" > 0 AND "github_repo_id" < 4503599627370496 AND "github_user_id" > 0),
  CONSTRAINT "credit_conversions_amount_check" CHECK ("lamports" BETWEEN 10000000 AND 100000000000 AND "credit_micro" > 0 AND "price_micro_per_sol" > 0),
  CONSTRAINT "credit_conversions_network_check" CHECK ("network" IN ('mainnet', 'devnet')),
  CONSTRAINT "credit_conversions_status_check" CHECK ("status" IN ('quoted', 'prepared', 'submitted', 'credited', 'review', 'expired', 'cancelled')),
  CONSTRAINT "credit_conversions_payment_check" CHECK (("status" <> 'submitted' OR "payment_signature" IS NOT NULL)
    AND ("status" NOT IN ('prepared', 'submitted') OR ("payer_wallet" IS NOT NULL AND "prepared_message" IS NOT NULL AND "last_valid_block_height" IS NOT NULL))),
  CONSTRAINT "credit_conversions_credited_check" CHECK (("status" = 'credited') = ("credited_micro" IS NOT NULL) AND ("credited_micro" IS NULL OR "credited_micro" > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_conversions_one_open" ON "credit_conversions" ("github_user_id") WHERE "status" IN ('quoted', 'prepared', 'submitted');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_conversions_by_repo" ON "credit_conversions" ("github_user_id", "github_repo_id", "id");
