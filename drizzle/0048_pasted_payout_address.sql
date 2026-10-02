-- Pasted payout addresses (src/payout-address.mjs, docs/CLAIM.md): a verified GitHub admin can set a repository's payout
-- address by pasting it instead of signing a message with that wallet. A pasted address is stored as a pending request and
-- becomes the repository's binding in repo_beneficiaries, which every payout path reads, only after a 48-hour hold. Until
-- then the previous binding (if any) keeps receiving claims, and any current admin can cancel the request. Wallet-signature
-- bindings stay instant and replace a waiting request. Requests are never deleted: their status and the append-only
-- payout_address_events table are the audit log.
-- Additive and idempotent: every object is created only if it is missing, so re-applying this file changes nothing.
CREATE TABLE IF NOT EXISTS "payout_address_requests" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "github_repo_id" bigint NOT NULL REFERENCES "repositories"("github_repo_id"),
  "wallet" varchar(44) NOT NULL,
  "requested_by_github_user_id" bigint NOT NULL,
  "requested_by_login" text NOT NULL,
  "requested_at" timestamptz DEFAULT now() NOT NULL,
  "active_at" timestamptz NOT NULL,
  "status" varchar(16) DEFAULT 'pending' NOT NULL,
  "resolved_at" timestamptz,
  "resolved_by_github_user_id" bigint,
  "resolution_reason" text,
  CONSTRAINT "payout_address_requests_status_check" CHECK ("status" IN ('pending', 'activated', 'cancelled', 'superseded')),
  CONSTRAINT "payout_address_requests_wallet_check" CHECK ("wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  CONSTRAINT "payout_address_requests_user_check" CHECK ("requested_by_github_user_id" > 0),
  -- The hold is a floor here as well, so no code path can store a shorter one.
  CONSTRAINT "payout_address_requests_hold_check" CHECK ("active_at" >= "requested_at" + interval '48 hours'),
  CONSTRAINT "payout_address_requests_resolution_check" CHECK (("status" = 'pending') = ("resolved_at" IS NULL)),
  CONSTRAINT "payout_address_requests_reason_check" CHECK ("status" NOT IN ('cancelled', 'superseded') OR "resolution_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payout_address_requests_one_pending" ON "payout_address_requests" ("github_repo_id") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payout_address_requests_due" ON "payout_address_requests" ("active_at") WHERE "status" = 'pending';
--> statement-breakpoint
-- A request's terms never change, a resolved request never reopens, and none activates before its hold has passed.
CREATE OR REPLACE FUNCTION guard_payout_address_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'pending' THEN
    RAISE EXCEPTION 'A resolved payout address request cannot change';
  END IF;
  IF (NEW."github_repo_id", NEW."wallet", NEW."requested_by_github_user_id", NEW."requested_at", NEW."active_at")
      IS DISTINCT FROM (OLD."github_repo_id", OLD."wallet", OLD."requested_by_github_user_id", OLD."requested_at", OLD."active_at") THEN
    RAISE EXCEPTION 'Payout address request terms cannot change';
  END IF;
  IF NEW."status" = 'activated' AND OLD."active_at" > now() THEN
    RAISE EXCEPTION 'Payout address hold has not ended';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'guard_payout_address_request'
      AND tgrelid = '"payout_address_requests"'::regclass) THEN
    CREATE TRIGGER guard_payout_address_request BEFORE UPDATE ON "payout_address_requests" FOR EACH ROW
      EXECUTE FUNCTION guard_payout_address_request();
  END IF;
END $$;
--> statement-breakpoint
-- How the repository's active binding was made, and by which request when pasted. Existing rows were all signature-bound.
ALTER TABLE "repo_beneficiaries" ADD COLUMN IF NOT EXISTS "method" varchar(16) DEFAULT 'signature' NOT NULL;
--> statement-breakpoint
ALTER TABLE "repo_beneficiaries" ADD COLUMN IF NOT EXISTS "payout_request_id" bigint REFERENCES "payout_address_requests"("id");
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repo_beneficiaries_method_check'
      AND conrelid = '"repo_beneficiaries"'::regclass) THEN
    ALTER TABLE "repo_beneficiaries" ADD CONSTRAINT "repo_beneficiaries_method_check" CHECK (
      ("method" = 'signature' AND "payout_request_id" IS NULL) OR ("method" = 'pasted' AND "payout_request_id" IS NOT NULL));
  END IF;
END $$;
--> statement-breakpoint
-- A pasted binding exists only as its own request, activated after the hold, for the same repository, wallet and GitHub
-- user. Pending addresses therefore never reach repo_beneficiaries, so no payout path can send funds to one.
CREATE OR REPLACE FUNCTION guard_pasted_beneficiary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."method" = 'pasted' AND NOT EXISTS (
      SELECT 1 FROM "payout_address_requests" r
      WHERE r."id" = NEW."payout_request_id" AND r."github_repo_id" = NEW."github_repo_id" AND r."wallet" = NEW."wallet"
        AND r."requested_by_github_user_id" = NEW."github_user_id" AND r."status" = 'activated' AND r."active_at" <= now()) THEN
    RAISE EXCEPTION 'Pasted payout address is not active';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'guard_pasted_beneficiary'
      AND tgrelid = '"repo_beneficiaries"'::regclass) THEN
    CREATE TRIGGER guard_pasted_beneficiary BEFORE INSERT OR UPDATE ON "repo_beneficiaries" FOR EACH ROW
      EXECUTE FUNCTION guard_pasted_beneficiary();
  END IF;
END $$;
--> statement-breakpoint
-- Who requested, cancelled or replaced a pasted address, and when one activated (by itself, so with no GitHub user).
CREATE TABLE IF NOT EXISTS "payout_address_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "request_id" bigint NOT NULL REFERENCES "payout_address_requests"("id"),
  "github_repo_id" bigint NOT NULL REFERENCES "repositories"("github_repo_id"),
  "event" varchar(16) NOT NULL,
  "github_user_id" bigint,
  "github_login" text,
  "wallet" varchar(44) NOT NULL,
  "previous_wallet" varchar(44),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "payout_address_events_event_check" CHECK ("event" IN ('requested', 'cancelled', 'superseded', 'activated')),
  CONSTRAINT "payout_address_events_actor_check" CHECK (("event" = 'activated') = ("github_user_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payout_address_events_repo" ON "payout_address_events" ("github_repo_id", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_payout_address_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Payout address events are append-only';
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'protect_payout_address_events'
      AND tgrelid = '"payout_address_events"'::regclass) THEN
    CREATE TRIGGER protect_payout_address_events BEFORE UPDATE OR DELETE ON "payout_address_events" FOR EACH ROW
      EXECUTE FUNCTION protect_payout_address_events();
  END IF;
END $$;
