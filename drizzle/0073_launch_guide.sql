-- Guided launch for maintainers (src/launch-guide.mjs, docs/LAUNCH_GUIDE.md): saved drafts so a maintainer can stop and resume a
-- launch plan, and conversion events that identify no one. Publishing a draft writes the existing launch_schedules row and
-- nothing else; nothing here moves money or changes an existing table. Expand-only and idempotent.
-- Drafts: one open draft per GitHub account (numeric id, which owns it) and repository; the plan is what the maintainer typed
-- (time, launching wallet, initial buy, note, optional ticker), the preflight the last check. Deleted by the web service 30 days
-- after their last change or their publication (the schedule is the public record).
-- Events: an event, a step, a source and an outcome from fixed lists and a public repository id. No login, GitHub id, wallet,
-- cookie, URL or IP. Deleted after 180 days.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "launch_guide_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "github_user_id" bigint NOT NULL CHECK ("github_user_id" > 0),
  "github_repo_id" bigint NOT NULL CHECK ("github_repo_id" > 0),
  "status" varchar(12) NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft', 'published')),
  "step" varchar(16) NOT NULL DEFAULT 'preflight' CHECK ("step" IN ('github', 'repository', 'preflight', 'plan', 'disclose', 'preview', 'publish')),
  "plan" jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof("plan") = 'object' AND pg_column_size("plan") <= 4096),
  "preflight" jsonb CHECK ("preflight" IS NULL OR jsonb_typeof("preflight") = 'object'),
  "preflight_at" timestamptz,
  "admin_login" text CHECK ("admin_login" ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  "admin_checked_at" timestamptz,
  "schedule_id" bigint REFERENCES "launch_schedules"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "published_at" timestamptz,
  CONSTRAINT "launch_guide_drafts_github_only" CHECK ("github_repo_id" < 4503599627370496),
  CONSTRAINT "launch_guide_drafts_published_check" CHECK (("status" = 'published') = ("schedule_id" IS NOT NULL AND "published_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "launch_guide_drafts_open" ON "launch_guide_drafts"("github_user_id", "github_repo_id") WHERE "status" = 'draft';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "launch_guide_drafts_user" ON "launch_guide_drafts"("github_user_id", "updated_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "launch_guide_drafts_updated" ON "launch_guide_drafts"("updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "launch_guide_events" (
  "id" bigserial PRIMARY KEY,
  "event" varchar(24) NOT NULL CHECK ("event" IN ('guide_view', 'step_view', 'github_connect', 'github_result', 'repo_selected', 'preflight_run',
    'draft_resumed', 'publish', 'draft_discarded')),
  "step" varchar(16) CHECK ("step" IN ('github', 'repository', 'preflight', 'plan', 'disclose', 'preview', 'publish')),
  "source" varchar(16) CHECK ("source" IN ('launch', 'repo', 'calendar', 'manage', 'builders', 'claim', 'opt-out', 'agents', 'cli', 'docs', 'x')),
  "outcome" varchar(16) CHECK ("outcome" IN ('verified', 'cancelled', 'failed', 'admin', 'not-admin', 'no-access', 'ready', 'needs-action',
    'blocked', 'unavailable', 'scheduled', 'refused')),
  "repo_id" bigint CHECK ("repo_id" BETWEEN 1 AND 4503599627370495),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "launch_guide_events_created_at" ON "launch_guide_events"("created_at");
