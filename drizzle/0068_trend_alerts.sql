-- Public "first to launch" posts (see src/trend-alerts.mjs): a public GitHub repository that is gaining stars fast and has
-- no market yet, posted at most once per channel to the launch-alert channels. Claimed ('sending') BEFORE the post is sent,
-- so overlapping workers or redeploys never post twice. 'failed' means the provider rejected the request (nothing posted;
-- retried up to a few times); 'unknown' means it may have been posted (timeout, 5xx, or a crash mid-send) and is never
-- retried automatically. No foreign key: a trending repository usually has no repositories row yet.
CREATE TABLE "trend_alerts" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "github_repo_id" bigint NOT NULL,
  "channel" varchar(16) NOT NULL CHECK ("channel" IN ('telegram', 'x')),
  "stars_gained" integer NOT NULL CHECK ("stars_gained" > 0),
  "status" varchar(16) NOT NULL CHECK ("status" IN ('sending', 'sent', 'failed', 'unknown')),
  "attempts" smallint NOT NULL DEFAULT 1 CHECK ("attempts" BETWEEN 1 AND 100),
  "message_id" varchar(64),
  "message_url" varchar(300),
  "error" varchar(300),
  "next_attempt_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at" timestamptz,
  CONSTRAINT "trend_alerts_sent_check" CHECK (
    ("status" = 'sent' AND "sent_at" IS NOT NULL AND "message_id" IS NOT NULL) OR ("status" <> 'sent' AND "sent_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX trend_alerts_repo_channel_unique ON trend_alerts(github_repo_id, channel);
--> statement-breakpoint
CREATE INDEX trend_alerts_channel_recent ON trend_alerts(channel, updated_at DESC);
