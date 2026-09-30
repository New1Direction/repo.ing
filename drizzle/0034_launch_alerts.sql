-- Public "new market launched" posts (see src/launch-alerts.mjs). One row per repository per channel, claimed
-- ('sending') BEFORE the post is sent so overlapping workers or redeploys never post twice. 'failed' means the provider
-- rejected the request (nothing posted; retried up to a few times); 'unknown' means it may have been posted (timeout,
-- 5xx, or a crash mid-send) and is never retried automatically.
CREATE TABLE "launch_alerts" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "github_repo_id" bigint NOT NULL REFERENCES "repositories"("github_repo_id"),
  "mint" varchar(44) NOT NULL,
  "channel" varchar(16) NOT NULL CHECK ("channel" IN ('telegram', 'x')),
  "status" varchar(16) NOT NULL CHECK ("status" IN ('sending', 'sent', 'failed', 'unknown')),
  "attempts" smallint NOT NULL DEFAULT 1 CHECK ("attempts" BETWEEN 1 AND 100),
  "message_id" varchar(64),
  "message_url" varchar(300),
  "error" varchar(300),
  "next_attempt_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at" timestamptz,
  CONSTRAINT "launch_alerts_sent_check" CHECK (
    ("status" = 'sent' AND "sent_at" IS NOT NULL AND "message_id" IS NOT NULL) OR ("status" <> 'sent' AND "sent_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX launch_alerts_repo_channel_unique ON launch_alerts(github_repo_id, channel);
--> statement-breakpoint
CREATE INDEX launch_alerts_channel_recent ON launch_alerts(channel, updated_at DESC);
