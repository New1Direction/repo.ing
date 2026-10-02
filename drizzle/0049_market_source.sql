-- Market source (groundwork for Hugging Face model markets; src/market-identity.mjs). Expand-only and idempotent: every
-- object is created only if missing, so re-applying this file changes nothing, and no existing row changes.
-- Every market id stays in the existing github_repo_id columns, so locks, unique indexes, views, triggers and ledgers work
-- unchanged (known debt: github_* names also hold Hugging Face ids). GitHub repository ids are below 2^52; Hugging Face
-- model markets take hf_models.market_ref, from 2^52+1 through 7e15 (still exact as a JavaScript Number).
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "source" varchar(16) DEFAULT 'github' NOT NULL;
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "hf_model_ref" bigint;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "hf_market_ref_seq" AS bigint
  START WITH 4503599627370497 MINVALUE 4503599627370497 MAXVALUE 7000000000000000 NO CYCLE;
--> statement-breakpoint
-- The registry: one market id per Hugging Face model, keyed by the model repository's stable _id (hf_id), never by its
-- owner/name path, which a rename or transfer can redirect to a different repository. owner_subject is the current owner's
-- _id when known; the flags are the last observed state (launch and claim paths re-read them).
CREATE TABLE IF NOT EXISTS "hf_models" (
  "market_ref" bigint PRIMARY KEY DEFAULT nextval('hf_market_ref_seq') NOT NULL,
  "hf_id" char(24) NOT NULL,
  "repo_path" text NOT NULL,
  "owner_handle" text NOT NULL,
  "owner_kind" varchar(8) NOT NULL,
  "owner_subject" char(24),
  "private" boolean DEFAULT false NOT NULL,
  "disabled" boolean DEFAULT false NOT NULL,
  "gated" boolean DEFAULT false NOT NULL,
  "base_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "path_confirmed_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "hf_models_hf_id_unique" UNIQUE ("hf_id"),
  CONSTRAINT "hf_models_market_ref_check" CHECK ("market_ref" BETWEEN 4503599627370497 AND 7000000000000000),
  CONSTRAINT "hf_models_hf_id_check" CHECK ("hf_id" ~ '^[0-9a-f]{24}$'),
  CONSTRAINT "hf_models_repo_path_check" CHECK (char_length("repo_path") BETWEEN 1 AND 200),
  CONSTRAINT "hf_models_owner_handle_check" CHECK (char_length("owner_handle") BETWEEN 1 AND 100),
  CONSTRAINT "hf_models_owner_kind_check" CHECK ("owner_kind" IN ('user', 'org')),
  CONSTRAINT "hf_models_owner_subject_check" CHECK ("owner_subject" IS NULL OR "owner_subject" ~ '^[0-9a-f]{24}$'),
  CONSTRAINT "hf_models_base_models_check" CHECK (jsonb_typeof("base_models") = 'array')
);
--> statement-breakpoint
-- A model's market id and _id never change once registered.
CREATE OR REPLACE FUNCTION protect_hf_model_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.market_ref IS DISTINCT FROM OLD.market_ref OR NEW.hf_id IS DISTINCT FROM OLD.hf_id THEN
    RAISE EXCEPTION 'Hugging Face model identity is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'protect_hf_model_identity' AND tgrelid = '"hf_models"'::regclass) THEN
    CREATE TRIGGER protect_hf_model_identity BEFORE UPDATE ON "hf_models" FOR EACH ROW EXECUTE FUNCTION protect_hf_model_identity();
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repositories_hf_model_ref_hf_models_market_ref_fk'
      AND conrelid = '"repositories"'::regclass) THEN
    ALTER TABLE "repositories" ADD CONSTRAINT "repositories_hf_model_ref_hf_models_market_ref_fk"
      FOREIGN KEY ("hf_model_ref") REFERENCES "hf_models"("market_ref");
  END IF;
END $$;
--> statement-breakpoint
-- The id range decides the source: a GitHub row has a GitHub id and no registry row; a Hugging Face row's id IS its
-- registry row's market_ref (IS NOT DISTINCT FROM, so a NULL reference fails instead of passing as unknown). Added NOT
-- VALID, then validated against the existing (all GitHub) rows.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repositories_source_range' AND conrelid = '"repositories"'::regclass) THEN
    ALTER TABLE "repositories" ADD CONSTRAINT "repositories_source_range" CHECK (
      ("source" = 'github' AND "github_repo_id" < 4503599627370496 AND "hf_model_ref" IS NULL) OR
      ("source" = 'huggingface' AND "github_repo_id" BETWEEN 4503599627370497 AND 7000000000000000
        AND "hf_model_ref" IS NOT DISTINCT FROM "github_repo_id")
    ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "repositories" VALIDATE CONSTRAINT "repositories_source_range";
--> statement-breakpoint
-- Hugging Face markets never carry the verification bonus (0047) or the 1% builder allocation (0011), whatever the
-- environment enables; the launch coordinator stamps NULL for them and this refuses anything else.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'markets_hf_no_rewards' AND conrelid = '"markets"'::regclass) THEN
    ALTER TABLE "markets" ADD CONSTRAINT "markets_hf_no_rewards" CHECK ("github_repo_id" < 4503599627370496 OR
      ("verification_bonus_lamports" IS NULL AND "builder_allocation_version" IS NULL)) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "markets" VALIDATE CONSTRAINT "markets_hf_no_rewards";
--> statement-breakpoint
-- GitHub-only features (verification bonuses, the builder allocation, reinvest, tips, parts funds, streams, Dev Pulse,
-- trends, participation, maintainer invites) refuse a Hugging Face id outright: "<table>_github_only".
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['verification_bonuses', 'verification_bonus_payouts', 'builder_allocation_claims',
    'builder_reinvest_intents', 'repo_tips', 'tip_transfers', 'parts_funds', 'parts_pledges', 'parts_transfers', 'parts_updates',
    'repo_streams', 'repo_pulse_events', 'repo_pulse_state', 'repo_pulse_star_hours', 'trend_candidates', 'trend_launches',
    'trend_observations', 'trend_reviews', 'trend_signals', 'repository_participation', 'maintainer_invites'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_github_only' AND conrelid = format('%I', t)::regclass) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (github_repo_id < 4503599627370496) NOT VALID', t, t || '_github_only');
    END IF;
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', t, t || '_github_only');
  END LOOP;
END $$;
