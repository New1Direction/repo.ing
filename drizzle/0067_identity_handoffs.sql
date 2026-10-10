-- AI credit packs for anyone with a GitHub account (src/credits-packs.mjs): a handoff may now confirm only who the account
-- is ('identity', no repository), besides an admin of a repository ('admin', as before; every existing row). The credit
-- ledger accepts identity handoffs for packs only; fee conversion still needs an admin handoff. Expand-only (a new column
-- with a default, a NOT NULL relaxed for identity rows) and idempotent.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "auth_handoffs" ADD COLUMN IF NOT EXISTS "permission" varchar(16) NOT NULL DEFAULT 'admin';
--> statement-breakpoint
ALTER TABLE "auth_handoffs" ALTER COLUMN "github_repo_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "auth_handoffs" DROP CONSTRAINT IF EXISTS "auth_handoffs_permission_check";
--> statement-breakpoint
ALTER TABLE "auth_handoffs" ADD CONSTRAINT "auth_handoffs_permission_check"
  CHECK ("permission" IN ('admin', 'identity') AND ("permission" = 'admin') = ("github_repo_id" IS NOT NULL));
