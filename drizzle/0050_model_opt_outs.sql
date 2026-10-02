-- Maintainer decisions for Hugging Face models (src/maintainer-opt-outs.mjs, app/api/opt-out/hf/route.js). The current
-- owner of a public Hugging Face model, or an admin of the organization that owns it, can decline the model's market or
-- opt a model without one out of repo.ing, the same two decisions a GitHub admin has for a repository (0041). A model's
-- decision is keyed by its registry market id (hf_models.market_ref, 0049) in github_repo_id, so every existing reader
-- (promotion exclusions, launch guards, the token page) works unchanged. It names its actor by Hugging Face user id
-- (the OIDC sub, a 24-hex _id) instead of a GitHub user id.
-- Expand-only and idempotent: every object is created only if missing, so re-applying this file changes nothing, and no
-- existing row changes. Existing rows are all GitHub decisions and satisfy every check below.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "maintainer_opt_outs" ADD COLUMN IF NOT EXISTS "authority_source" varchar(16) DEFAULT 'github' NOT NULL;
--> statement-breakpoint
ALTER TABLE "maintainer_opt_outs" ADD COLUMN IF NOT EXISTS "actor_subject" char(24);
--> statement-breakpoint
ALTER TABLE "maintainer_opt_outs" ADD COLUMN IF NOT EXISTS "withdrawn_by_subject" char(24);
--> statement-breakpoint
-- A Hugging Face decision has no GitHub user. The existing "github_user_id > 0" check still holds for every GitHub row.
ALTER TABLE "maintainer_opt_outs" ALTER COLUMN "github_user_id" DROP NOT NULL;
--> statement-breakpoint
-- Exactly one kind of actor, matching the source: GitHub user ids for a GitHub decision, Hugging Face subjects for a model's.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maintainer_opt_outs_actor_check'
      AND conrelid = '"maintainer_opt_outs"'::regclass) THEN
    ALTER TABLE "maintainer_opt_outs" ADD CONSTRAINT "maintainer_opt_outs_actor_check" CHECK (
      ("authority_source" = 'github' AND "github_user_id" IS NOT NULL AND "actor_subject" IS NULL AND "withdrawn_by_subject" IS NULL) OR
      ("authority_source" = 'huggingface' AND "github_user_id" IS NULL AND "withdrawn_by_github_user_id" IS NULL
        AND "actor_subject" IS NOT NULL AND "actor_subject" ~ '^[0-9a-f]{24}$' AND ("withdrawn_by_subject" IS NULL OR "withdrawn_by_subject" ~ '^[0-9a-f]{24}$'))
    ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "maintainer_opt_outs" VALIDATE CONSTRAINT "maintainer_opt_outs_actor_check";
--> statement-breakpoint
-- The id range decides the source (src/market-identity.mjs): a model's decision always names a registry market id.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maintainer_opt_outs_source_range'
      AND conrelid = '"maintainer_opt_outs"'::regclass) THEN
    ALTER TABLE "maintainer_opt_outs" ADD CONSTRAINT "maintainer_opt_outs_source_range" CHECK (
      ("authority_source" = 'github' AND "github_repo_id" < 4503599627370496) OR
      ("authority_source" = 'huggingface' AND "github_repo_id" BETWEEN 4503599627370497 AND 7000000000000000)
    ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "maintainer_opt_outs" VALIDATE CONSTRAINT "maintainer_opt_outs_source_range";
--> statement-breakpoint
-- Withdrawn by exactly one actor, no earlier than created. Rewritten from 0041, which knew only GitHub withdrawers: the
-- definition is replaced once (re-applying finds the new definition and skips), keeping the constraint's name.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maintainer_opt_outs_withdrawn_check'
      AND conrelid = '"maintainer_opt_outs"'::regclass AND pg_get_constraintdef(oid) LIKE '%withdrawn_by_subject%') THEN
    ALTER TABLE "maintainer_opt_outs" DROP CONSTRAINT IF EXISTS "maintainer_opt_outs_withdrawn_check";
    ALTER TABLE "maintainer_opt_outs" ADD CONSTRAINT "maintainer_opt_outs_withdrawn_check" CHECK (
      ("withdrawn_at" IS NULL) = ("withdrawn_by_github_user_id" IS NULL AND "withdrawn_by_subject" IS NULL)
      AND ("withdrawn_by_github_user_id" IS NULL OR "withdrawn_by_subject" IS NULL)
      AND ("withdrawn_at" IS NULL OR "withdrawn_at" >= "created_at")
    ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "maintainer_opt_outs" VALIDATE CONSTRAINT "maintainer_opt_outs_withdrawn_check";
