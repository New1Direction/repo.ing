-- Repository lineage for the fork guard (src/repo-lineage.mjs; docs/FORK_GUARD.md). A GitHub fork whose parent or source
-- already has a market cannot launch, and neither can a repository pushed fresh from an older launched repository's history
-- (same first commit). Other forks launch, shown as "Fork of <parent>".
-- root_commit: the repository's first commit on its default branch, read at launch review and filled in by the worker for
-- markets launched before this migration. fork_parent_*: the repository GitHub says it was forked from (null when it is not a
-- fork). lineage_checked_at: when the first commit was last read (null: not yet), so the worker reads each repository once.
-- Expand-only and idempotent: nullable columns and an index, each added only if missing. No existing row changes.
-- All pending migrations run in one transaction, so the locks taken below are held until it commits: give up after 5s
-- (the deploy fails and can simply be retried) rather than queue every page query behind a long-running read.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "root_commit" varchar(40);
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "fork_parent_id" bigint;
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "fork_parent_full_name" text;
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "lineage_checked_at" timestamptz;
--> statement-breakpoint
-- The copy check: launched repositories sharing a first commit.
CREATE INDEX IF NOT EXISTS "repositories_root_commit" ON "repositories" ("root_commit") WHERE "root_commit" IS NOT NULL;
