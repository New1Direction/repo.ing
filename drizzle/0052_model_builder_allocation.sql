-- The 1% builder allocation for Hugging Face model markets (src/builder-allocation.mjs, app/api/allocation/[repo]/route.js).
-- Owner decision: a model market keeps the allocation, and the model's verified Hugging Face owner (the user who owns it,
-- or an admin of the organization that owns it) claims it after verified graduation, under the GitHub rules
-- (docs/BUILDER_ALLOCATION_PLAN.md): current authority re-checked at claim time, payout to the wallet bound through the
-- model's Hugging Face binding (0051), one grant per market ever (builder_allocation_one_payout, 0011).
--   markets: a model market may now be stamped with the allocation. It still never carries the verification bonus: that
--     half of markets_hf_no_rewards (0049) stays, as markets_hf_no_bonus.
--   builder_allocation_claims: a claim names the authority behind it like a 0051 binding does (a GitHub user id, or the
--     Hugging Face user's sub and the model owner's _id at claim time), and the GitHub-only check (0049) becomes a
--     source-range check, so model market ids (4503599627370497..7000000000000000) are accepted under a Hugging Face
--     authority only. A CHECK that evaluates to NULL passes, so every subject test says IS NOT NULL before its pattern.
-- Expand-only and idempotent: each object is created only if missing and each relaxed check is dropped only if present,
-- so re-applying this file changes nothing, and no existing row changes. Every existing allocation claim is a GitHub row
-- (source 'github', a GitHub user id) and satisfies the new checks.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'markets_hf_no_bonus' AND conrelid = '"markets"'::regclass) THEN
    ALTER TABLE "markets" ADD CONSTRAINT "markets_hf_no_bonus" CHECK ("github_repo_id" < 4503599627370496 OR "verification_bonus_lamports" IS NULL) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "markets" VALIDATE CONSTRAINT "markets_hf_no_bonus";
--> statement-breakpoint
ALTER TABLE "markets" DROP CONSTRAINT IF EXISTS "markets_hf_no_rewards";
--> statement-breakpoint
ALTER TABLE "builder_allocation_claims" ADD COLUMN IF NOT EXISTS "authority_source" varchar(16) DEFAULT 'github' NOT NULL;
--> statement-breakpoint
ALTER TABLE "builder_allocation_claims" ADD COLUMN IF NOT EXISTS "authority_subject" char(24);
--> statement-breakpoint
ALTER TABLE "builder_allocation_claims" ADD COLUMN IF NOT EXISTS "authority_owner_subject" char(24);
--> statement-breakpoint
-- A Hugging Face claim has no GitHub user.
ALTER TABLE "builder_allocation_claims" ALTER COLUMN "github_user_id" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'builder_allocation_claims_authority_check'
      AND conrelid = '"builder_allocation_claims"'::regclass) THEN
    ALTER TABLE "builder_allocation_claims" ADD CONSTRAINT "builder_allocation_claims_authority_check" CHECK (
      ("authority_source" = 'github' AND "github_user_id" IS NOT NULL AND "authority_subject" IS NULL AND "authority_owner_subject" IS NULL) OR
      ("authority_source" = 'huggingface' AND "github_user_id" IS NULL
        AND "authority_subject" IS NOT NULL AND "authority_subject" ~ '^[0-9a-f]{24}$' AND "authority_owner_subject" IS NOT NULL AND "authority_owner_subject" ~ '^[0-9a-f]{24}$')
    ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "builder_allocation_claims" VALIDATE CONSTRAINT "builder_allocation_claims_authority_check";
--> statement-breakpoint
-- The id range decides the source (src/market-identity.mjs): a GitHub authority never claims a model market's grant, nor a
-- Hugging Face one a repository's.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'builder_allocation_claims_source_range'
      AND conrelid = '"builder_allocation_claims"'::regclass) THEN
    ALTER TABLE "builder_allocation_claims" ADD CONSTRAINT "builder_allocation_claims_source_range" CHECK (
      ("authority_source" = 'github' AND "github_repo_id" < 4503599627370496) OR
      ("authority_source" = 'huggingface' AND "github_repo_id" BETWEEN 4503599627370497 AND 7000000000000000)
    ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "builder_allocation_claims" VALIDATE CONSTRAINT "builder_allocation_claims_source_range";
--> statement-breakpoint
ALTER TABLE "builder_allocation_claims" DROP CONSTRAINT IF EXISTS "builder_allocation_claims_github_only";
