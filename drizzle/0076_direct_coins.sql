-- Preview-only direct coins: isolated from markets, schedules and signing sessions.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS direct_coin_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_user_id bigint NOT NULL CHECK (github_user_id > 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object' AND pg_column_size(plan) <= 4096),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS direct_coin_drafts_user ON direct_coin_drafts(github_user_id, updated_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS direct_coin_events (
  id bigserial PRIMARY KEY,
  github_user_id bigint NOT NULL CHECK (github_user_id > 0),
  draft_id uuid REFERENCES direct_coin_drafts(id) ON DELETE CASCADE,
  revision integer CHECK (revision > 0),
  action text NOT NULL CHECK (action IN ('save', 'inspect')),
  adapter text NOT NULL CHECK (adapter IN ('raydium', 'meteora-dbc', 'meteora-damm', 'hooklab')),
  outcome text NOT NULL CHECK (outcome IN ('saved', 'refused', 'programs-present', 'missing-programs', 'unavailable')),
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object' AND pg_column_size(plan) <= 4096),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS direct_coin_events_user ON direct_coin_events(github_user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS direct_coin_events_created ON direct_coin_events(created_at);
