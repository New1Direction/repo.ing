-- Launch transparency (docs/LAUNCH_TRANSPARENCY.md): scheduled launches announced by a repository's current GitHub admin
-- (src/launch-schedules.mjs), the worker's liquidity and LP position samples (src/market-liquidity.mjs, src/lp-positions.mjs),
-- the latest Launch Quality report per market (src/launch-quality.mjs), operator-recorded wallet links
-- (src/wallet-clusters.mjs), and the public launch feed with its webhook subscriptions (src/launch-feed.mjs,
-- src/launch-webhooks.mjs). Nothing here moves money or changes an existing table. Expand-only and idempotent.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "launch_schedules" (
  "id" bigserial PRIMARY KEY,
  "github_repo_id" bigint NOT NULL REFERENCES "repositories"("github_repo_id"),
  "status" varchar(16) NOT NULL DEFAULT 'scheduled' CHECK ("status" IN ('scheduled', 'cancelled', 'launched', 'lapsed')),
  "scheduled_at" timestamptz NOT NULL,
  "window_minutes" integer NOT NULL CHECK ("window_minutes" BETWEEN 15 AND 1440),
  "launcher_wallet" varchar(44) NOT NULL CHECK ("launcher_wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  "max_initial_buy_lamports" numeric(20, 0) NOT NULL DEFAULT 0 CHECK ("max_initial_buy_lamports" BETWEEN 0 AND 10000000000),
  "note" varchar(280),
  "github_user_id" bigint NOT NULL CHECK ("github_user_id" > 0),
  "github_login" text NOT NULL CHECK ("github_login" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$'),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "cancelled_at" timestamptz,
  "cancelled_by_github_user_id" bigint,
  "launched_mint" varchar(44),
  CONSTRAINT "launch_schedules_github_only" CHECK ("github_repo_id" < 4503599627370496),
  CONSTRAINT "launch_schedules_notice_check" CHECK ("scheduled_at" >= "created_at" + interval '1 hour'
    AND "scheduled_at" <= "created_at" + interval '30 days'),
  CONSTRAINT "launch_schedules_cancel_check" CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)),
  CONSTRAINT "launch_schedules_launched_check" CHECK (("status" = 'launched') = ("launched_mint" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "launch_schedules_one_scheduled" ON "launch_schedules"("github_repo_id") WHERE "status" = 'scheduled';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "launch_schedules_upcoming" ON "launch_schedules"("scheduled_at") WHERE "status" = 'scheduled';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "launch_schedules_repo" ON "launch_schedules"("github_repo_id", "created_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "market_liquidity_samples" (
  "id" bigserial PRIMARY KEY,
  "github_repo_id" bigint NOT NULL REFERENCES "markets"("github_repo_id"),
  "sampled_at" timestamptz NOT NULL DEFAULT now(),
  "venue" varchar(8) NOT NULL CHECK ("venue" IN ('curve', 'damm')),
  "pool" varchar(44) NOT NULL,
  "sqrt_price" numeric(39, 0) NOT NULL CHECK ("sqrt_price" > 0),
  "fee_bps" integer NOT NULL CHECK ("fee_bps" BETWEEN 0 AND 10000),
  "quote_reserve_lamports" numeric(20, 0) CHECK ("quote_reserve_lamports" >= 0),
  "buy_depth_lamports" numeric(20, 0) NOT NULL CHECK ("buy_depth_lamports" >= 0),
  "sell_depth_lamports" numeric(20, 0) NOT NULL CHECK ("sell_depth_lamports" >= 0),
  "spread_bps" integer CHECK ("spread_bps" BETWEEN 0 AND 1000000),
  "two_sided" boolean NOT NULL,
  "profile" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_liquidity_samples_repo_time" ON "market_liquidity_samples"("github_repo_id", "sampled_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_liquidity_samples_time" ON "market_liquidity_samples"("sampled_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lp_position_samples" (
  "id" bigserial PRIMARY KEY,
  "github_repo_id" bigint NOT NULL REFERENCES "markets"("github_repo_id"),
  "sampled_at" timestamptz NOT NULL,
  "pool" varchar(44) NOT NULL,
  "position" varchar(44) NOT NULL,
  "owner" varchar(44),
  "liquidity" numeric(40, 0) NOT NULL CHECK ("liquidity" >= 0),
  "permanent_locked_liquidity" numeric(40, 0) NOT NULL CHECK ("permanent_locked_liquidity" >= 0),
  "pool_liquidity" numeric(40, 0) NOT NULL CHECK ("pool_liquidity" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lp_position_samples_unique" ON "lp_position_samples"("position", "sampled_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lp_position_samples_repo_time" ON "lp_position_samples"("github_repo_id", "sampled_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "launch_quality_reports" (
  "github_repo_id" bigint PRIMARY KEY REFERENCES "markets"("github_repo_id"),
  "version" smallint NOT NULL CHECK ("version" >= 1),
  "assessed_at" timestamptz NOT NULL,
  "score" smallint CHECK ("score" BETWEEN 0 AND 100),
  "coverage_percent" smallint NOT NULL CHECK ("coverage_percent" BETWEEN 0 AND 100),
  "report" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_links" (
  "id" bigserial PRIMARY KEY,
  "wallet_a" varchar(44) NOT NULL CHECK ("wallet_a" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  "wallet_b" varchar(44) NOT NULL CHECK ("wallet_b" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  "evidence" varchar(500) NOT NULL CHECK (length(trim("evidence")) >= 8),
  "recorded_by" varchar(100) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "removed_at" timestamptz,
  CONSTRAINT "wallet_links_order_check" CHECK ("wallet_a" < "wallet_b")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_links_pair_active" ON "wallet_links"("wallet_a", "wallet_b") WHERE "removed_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "launch_feed_events" (
  "id" bigserial PRIMARY KEY,
  "kind" varchar(40) NOT NULL CHECK ("kind" IN ('launch.scheduled', 'launch.schedule_cancelled', 'launch.window_open',
    'launch.schedule_lapsed', 'market.launched', 'market.graduated', 'group_launch.raising', 'group_launch.launched',
    'group_launch.failed')),
  "dedupe_key" varchar(120) NOT NULL,
  "github_repo_id" bigint NOT NULL CHECK ("github_repo_id" > 0),
  "occurred_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "launch_feed_events_dedupe" ON "launch_feed_events"("dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "launch_feed_events_recent" ON "launch_feed_events"("id" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "launch_webhooks" (
  "id" uuid PRIMARY KEY,
  "github_user_id" bigint NOT NULL CHECK ("github_user_id" > 0),
  "github_login" text NOT NULL,
  "url" varchar(500) NOT NULL CHECK ("url" ~ '^https://'),
  "kinds" text[] NOT NULL,
  "repo_ids" bigint[],
  "status" varchar(16) NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'disabled', 'deleted')),
  "consecutive_failures" integer NOT NULL DEFAULT 0 CHECK ("consecutive_failures" >= 0),
  "last_event_id" bigint NOT NULL DEFAULT 0,
  "last_delivery_at" timestamptz,
  "disabled_reason" varchar(64),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "launch_webhooks_user" ON "launch_webhooks"("github_user_id") WHERE "status" <> 'deleted';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "launch_webhook_deliveries" (
  "webhook_id" uuid NOT NULL REFERENCES "launch_webhooks"("id"),
  "event_id" bigint NOT NULL REFERENCES "launch_feed_events"("id"),
  "status" varchar(16) NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'sending', 'sent', 'failed')),
  "attempts" smallint NOT NULL DEFAULT 0 CHECK ("attempts" BETWEEN 0 AND 100),
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_status" integer,
  "last_error" varchar(120),
  "sent_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("webhook_id", "event_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "launch_webhook_deliveries_due" ON "launch_webhook_deliveries"("next_attempt_at") WHERE "status" IN ('pending', 'sending');
