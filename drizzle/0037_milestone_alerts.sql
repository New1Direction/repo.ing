-- Public graduation-milestone posts (see src/milestone-alerts.mjs): a market passing 25, 50, 75 or 90% of its
-- graduation target, or graduating (milestone 100), posted to the launch-alert channels. Separate from launch_alerts
-- (whose rows and unique index are unchanged) and from the operator-only graduation_alerts.
-- One row per repository, channel and milestone, claimed ('sending') BEFORE the post is sent so overlapping workers or
-- redeploys never post twice. 'failed' means the provider rejected the request (nothing posted; retried up to a few
-- times); 'unknown' means it may have been posted (timeout, 5xx, or a crash mid-send) and is never retried automatically.
CREATE TABLE "milestone_alerts" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "github_repo_id" bigint NOT NULL REFERENCES "repositories"("github_repo_id"),
  "mint" varchar(44) NOT NULL,
  "channel" varchar(16) NOT NULL CHECK ("channel" IN ('telegram', 'x')),
  "milestone" smallint NOT NULL CHECK ("milestone" IN (25, 50, 75, 90, 100)),
  "status" varchar(16) NOT NULL CHECK ("status" IN ('sending', 'sent', 'failed', 'unknown')),
  "attempts" smallint NOT NULL DEFAULT 1 CHECK ("attempts" BETWEEN 1 AND 100),
  "message_id" varchar(64),
  "message_url" varchar(300),
  "error" varchar(300),
  "next_attempt_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at" timestamptz,
  CONSTRAINT "milestone_alerts_sent_check" CHECK (
    ("status" = 'sent' AND "sent_at" IS NOT NULL AND "message_id" IS NOT NULL) OR ("status" <> 'sent' AND "sent_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX milestone_alerts_repo_channel_milestone_unique ON milestone_alerts(github_repo_id, channel, milestone);
--> statement-breakpoint
CREATE INDEX milestone_alerts_channel_recent ON milestone_alerts(channel, updated_at DESC);
--> statement-breakpoint
-- Per repository and channel: the highest milestone the market had already reached when the job first saw it (fresh,
-- verified progress) at or after GRADUATION_ALERTS_SINCE. Milestones at or below the mark are never posted, so turning
-- the job (or a new channel) on never announces old crossings. A mark taken before the current cutoff is re-taken at the
-- market's current milestone; marks are never lowered. 0 means below 25%.
CREATE TABLE "milestone_alert_marks" (
  "github_repo_id" bigint NOT NULL REFERENCES "repositories"("github_repo_id"),
  "channel" varchar(16) NOT NULL CHECK ("channel" IN ('telegram', 'x')),
  "milestone" smallint NOT NULL CHECK ("milestone" IN (0, 25, 50, 75, 90, 100)),
  "marked_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "milestone_alert_marks_pkey" PRIMARY KEY ("github_repo_id", "channel")
);
