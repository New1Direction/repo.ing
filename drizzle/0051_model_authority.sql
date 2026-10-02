-- Payout authority for Hugging Face model markets (src/hf-verification.mjs, src/wallet-binding.mjs, src/claim.mjs,
-- src/payout-address.mjs). A model's payout wallet is set, and its fees claimed, by the model's CURRENT owner on Hugging
-- Face: the user who owns it, or an admin of the organization that owns it. Hugging Face users have no GitHub user id, so
-- every table that names the person behind a binding gains the source of that authority and Hugging Face subjects (24-hex
-- _ids): authority_subject is the signed-in user (OIDC sub), authority_owner_subject the model owner's _id when the
-- binding was made. A claim pays a model's binding only while the owner is still that owner; after a transfer the new
-- owner must bind again (src/claim.mjs). Each row names exactly one kind of actor, matching its source. A CHECK that
-- evaluates to NULL passes, so every subject test below says IS NOT NULL before matching its pattern.
-- Expand-only and idempotent: every object is created only if missing, so re-applying this file changes nothing, and no
-- existing row changes. Every existing row is a GitHub row (source 'github', a GitHub user id) and satisfies the checks.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- A fresh Hugging Face authority check, recorded like repo_verifications: wallet binding and pasted addresses for a model
-- require one from the last five minutes, for the same user and the same current owner.
CREATE TABLE IF NOT EXISTS "model_verifications" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "github_repo_id" bigint NOT NULL REFERENCES "repositories"("github_repo_id"),
  "hf_id" char(24) NOT NULL,
  "subject" char(24) NOT NULL,
  "username" text NOT NULL,
  "owner_kind" varchar(8) NOT NULL,
  "owner_subject" char(24) NOT NULL,
  "role" varchar(16) NOT NULL,
  "verified_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "model_verifications_market_range" CHECK ("github_repo_id" BETWEEN 4503599627370497 AND 7000000000000000),
  CONSTRAINT "model_verifications_hf_id_check" CHECK ("hf_id" ~ '^[0-9a-f]{24}$'),
  CONSTRAINT "model_verifications_subject_check" CHECK ("subject" ~ '^[0-9a-f]{24}$' AND "owner_subject" ~ '^[0-9a-f]{24}$'),
  CONSTRAINT "model_verifications_username_check" CHECK (char_length("username") BETWEEN 1 AND 100),
  -- A user-owned model is claimed by its owner; an organization's by one of its admins.
  CONSTRAINT "model_verifications_role_check" CHECK (
    ("owner_kind" = 'user' AND "role" = 'owner' AND "owner_subject" = "subject") OR
    ("owner_kind" = 'org' AND "role" = 'admin' AND "owner_subject" <> "subject"))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_verifications_recent" ON "model_verifications" ("github_repo_id", "subject", "verified_at");
--> statement-breakpoint
ALTER TABLE "repo_beneficiaries" ADD COLUMN IF NOT EXISTS "authority_source" varchar(16) DEFAULT 'github' NOT NULL;
--> statement-breakpoint
ALTER TABLE "repo_beneficiaries" ADD COLUMN IF NOT EXISTS "authority_subject" char(24);
--> statement-breakpoint
ALTER TABLE "repo_beneficiaries" ADD COLUMN IF NOT EXISTS "authority_owner_subject" char(24);
--> statement-breakpoint
ALTER TABLE "repo_beneficiaries" ALTER COLUMN "github_user_id" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repo_beneficiaries_authority_check'
      AND conrelid = '"repo_beneficiaries"'::regclass) THEN
    ALTER TABLE "repo_beneficiaries" ADD CONSTRAINT "repo_beneficiaries_authority_check" CHECK (
      ("authority_source" = 'github' AND "github_user_id" IS NOT NULL AND "authority_subject" IS NULL AND "authority_owner_subject" IS NULL) OR
      ("authority_source" = 'huggingface' AND "github_user_id" IS NULL
        AND "authority_subject" IS NOT NULL AND "authority_subject" ~ '^[0-9a-f]{24}$' AND "authority_owner_subject" IS NOT NULL AND "authority_owner_subject" ~ '^[0-9a-f]{24}$')
    ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "repo_beneficiaries" VALIDATE CONSTRAINT "repo_beneficiaries_authority_check";
--> statement-breakpoint
-- Every payout path reads this table: a GitHub authority can never bind a model market, nor a Hugging Face one a repository.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repo_beneficiaries_source_range'
      AND conrelid = '"repo_beneficiaries"'::regclass) THEN
    ALTER TABLE "repo_beneficiaries" ADD CONSTRAINT "repo_beneficiaries_source_range" CHECK (
      ("authority_source" = 'github' AND "github_repo_id" < 4503599627370496) OR
      ("authority_source" = 'huggingface' AND "github_repo_id" BETWEEN 4503599627370497 AND 7000000000000000)
    ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "repo_beneficiaries" VALIDATE CONSTRAINT "repo_beneficiaries_source_range";
--> statement-breakpoint
ALTER TABLE "wallet_binding_challenges" ADD COLUMN IF NOT EXISTS "authority_source" varchar(16) DEFAULT 'github' NOT NULL;
--> statement-breakpoint
ALTER TABLE "wallet_binding_challenges" ADD COLUMN IF NOT EXISTS "authority_subject" char(24);
--> statement-breakpoint
ALTER TABLE "wallet_binding_challenges" ADD COLUMN IF NOT EXISTS "authority_owner_subject" char(24);
--> statement-breakpoint
ALTER TABLE "wallet_binding_challenges" ALTER COLUMN "github_user_id" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_binding_challenges_authority_check'
      AND conrelid = '"wallet_binding_challenges"'::regclass) THEN
    ALTER TABLE "wallet_binding_challenges" ADD CONSTRAINT "wallet_binding_challenges_authority_check" CHECK (
      ("authority_source" = 'github' AND "github_user_id" IS NOT NULL AND "authority_subject" IS NULL AND "authority_owner_subject" IS NULL) OR
      ("authority_source" = 'huggingface' AND "github_user_id" IS NULL
        AND "authority_subject" IS NOT NULL AND "authority_subject" ~ '^[0-9a-f]{24}$' AND "authority_owner_subject" IS NOT NULL AND "authority_owner_subject" ~ '^[0-9a-f]{24}$')
    ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "wallet_binding_challenges" VALIDATE CONSTRAINT "wallet_binding_challenges_authority_check";
--> statement-breakpoint
-- A Hugging Face challenge only ever names a model market. (A GitHub-authority challenge naming a model id is refused by
-- the binding code before anything is consumed or bound, and by repo_beneficiaries_source_range; it is not refused here.)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_binding_challenges_hf_range'
      AND conrelid = '"wallet_binding_challenges"'::regclass) THEN
    ALTER TABLE "wallet_binding_challenges" ADD CONSTRAINT "wallet_binding_challenges_hf_range" CHECK (
      "authority_source" <> 'huggingface' OR "github_repo_id" BETWEEN 4503599627370497 AND 7000000000000000
    ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "wallet_binding_challenges" VALIDATE CONSTRAINT "wallet_binding_challenges_hf_range";
--> statement-breakpoint
-- Pasted payout addresses (0048) for model markets: requested, cancelled or replaced by a Hugging Face authority.
ALTER TABLE "payout_address_requests" ADD COLUMN IF NOT EXISTS "authority_source" varchar(16) DEFAULT 'github' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payout_address_requests" ADD COLUMN IF NOT EXISTS "requested_by_subject" char(24);
--> statement-breakpoint
ALTER TABLE "payout_address_requests" ADD COLUMN IF NOT EXISTS "requested_by_owner_subject" char(24);
--> statement-breakpoint
ALTER TABLE "payout_address_requests" ADD COLUMN IF NOT EXISTS "resolved_by_subject" char(24);
--> statement-breakpoint
ALTER TABLE "payout_address_requests" ALTER COLUMN "requested_by_github_user_id" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payout_address_requests_authority_check'
      AND conrelid = '"payout_address_requests"'::regclass) THEN
    ALTER TABLE "payout_address_requests" ADD CONSTRAINT "payout_address_requests_authority_check" CHECK (
      ("authority_source" = 'github' AND "requested_by_github_user_id" IS NOT NULL AND "requested_by_subject" IS NULL
        AND "requested_by_owner_subject" IS NULL AND "resolved_by_subject" IS NULL) OR
      ("authority_source" = 'huggingface' AND "requested_by_github_user_id" IS NULL AND "resolved_by_github_user_id" IS NULL
        AND "requested_by_subject" IS NOT NULL AND "requested_by_subject" ~ '^[0-9a-f]{24}$' AND "requested_by_owner_subject" IS NOT NULL AND "requested_by_owner_subject" ~ '^[0-9a-f]{24}$'
        AND ("resolved_by_subject" IS NULL OR "resolved_by_subject" ~ '^[0-9a-f]{24}$'))
    ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "payout_address_requests" VALIDATE CONSTRAINT "payout_address_requests_authority_check";
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payout_address_requests_source_range'
      AND conrelid = '"payout_address_requests"'::regclass) THEN
    ALTER TABLE "payout_address_requests" ADD CONSTRAINT "payout_address_requests_source_range" CHECK (
      ("authority_source" = 'github' AND "github_repo_id" < 4503599627370496) OR
      ("authority_source" = 'huggingface' AND "github_repo_id" BETWEEN 4503599627370497 AND 7000000000000000)
    ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "payout_address_requests" VALIDATE CONSTRAINT "payout_address_requests_source_range";
--> statement-breakpoint
-- 0048's insert guard, now also refusing a request stored already resolved by a Hugging Face user.
CREATE OR REPLACE FUNCTION start_payout_address_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'pending' OR NEW."resolved_at" IS NOT NULL OR NEW."resolved_by_github_user_id" IS NOT NULL
      OR NEW."resolved_by_subject" IS NOT NULL OR NEW."resolution_reason" IS NOT NULL THEN
    RAISE EXCEPTION 'A payout address request starts pending';
  END IF;
  NEW."requested_at" := clock_timestamp();
  NEW."active_at" := greatest(NEW."active_at", NEW."requested_at" + interval '48 hours');
  NEW."replaces_bound_at" := (SELECT b."bound_at" FROM "repo_beneficiaries" b WHERE b."github_repo_id" = NEW."github_repo_id");
  RETURN NEW;
END $$;
--> statement-breakpoint
-- 0048's update guard: the request's authority is part of its terms and never changes either.
CREATE OR REPLACE FUNCTION guard_payout_address_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'pending' THEN
    RAISE EXCEPTION 'A resolved payout address request cannot change';
  END IF;
  IF (NEW."github_repo_id", NEW."wallet", NEW."requested_by_github_user_id", NEW."requested_at", NEW."active_at", NEW."replaces_bound_at",
      NEW."authority_source", NEW."requested_by_subject", NEW."requested_by_owner_subject")
      IS DISTINCT FROM (OLD."github_repo_id", OLD."wallet", OLD."requested_by_github_user_id", OLD."requested_at", OLD."active_at",
      OLD."replaces_bound_at", OLD."authority_source", OLD."requested_by_subject", OLD."requested_by_owner_subject") THEN
    RAISE EXCEPTION 'Payout address request terms cannot change';
  END IF;
  IF NEW."status" = 'activated' AND OLD."active_at" > now() THEN
    RAISE EXCEPTION 'Payout address hold has not ended';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- 0048's binding guard: a pasted binding is its own activated request, for the same repository, wallet and authority
-- (the same GitHub user, or the same Hugging Face user and model owner). For GitHub rows this is the 0048 rule exactly:
-- both user ids are set and the subjects are both null.
CREATE OR REPLACE FUNCTION guard_pasted_beneficiary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."method" = 'pasted' AND NOT EXISTS (
      SELECT 1 FROM "payout_address_requests" r
      WHERE r."id" = NEW."payout_request_id" AND r."github_repo_id" = NEW."github_repo_id" AND r."wallet" = NEW."wallet"
        AND r."authority_source" = NEW."authority_source"
        AND r."requested_by_github_user_id" IS NOT DISTINCT FROM NEW."github_user_id"
        AND r."requested_by_subject" IS NOT DISTINCT FROM NEW."authority_subject"
        AND r."requested_by_owner_subject" IS NOT DISTINCT FROM NEW."authority_owner_subject"
        AND r."status" = 'activated' AND r."active_at" <= now()) THEN
    RAISE EXCEPTION 'Pasted payout address is not active';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
ALTER TABLE "payout_address_events" ADD COLUMN IF NOT EXISTS "actor_subject" char(24);
--> statement-breakpoint
-- Every event but an activation names exactly one actor: a GitHub user on a repository, a Hugging Face user on a model
-- market. Rewritten from 0048 (GitHub users only) once, keeping the constraint's name.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payout_address_events_actor_check'
      AND conrelid = '"payout_address_events"'::regclass AND pg_get_constraintdef(oid) LIKE '%actor_subject%') THEN
    ALTER TABLE "payout_address_events" DROP CONSTRAINT IF EXISTS "payout_address_events_actor_check";
    ALTER TABLE "payout_address_events" ADD CONSTRAINT "payout_address_events_actor_check" CHECK (
      ("event" = 'activated') = ("github_user_id" IS NULL AND "actor_subject" IS NULL)
      AND ("github_user_id" IS NULL OR "github_repo_id" < 4503599627370496)
      AND ("actor_subject" IS NULL OR ("actor_subject" ~ '^[0-9a-f]{24}$'
        AND "github_repo_id" BETWEEN 4503599627370497 AND 7000000000000000))
    ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "payout_address_events" VALIDATE CONSTRAINT "payout_address_events_actor_check";
