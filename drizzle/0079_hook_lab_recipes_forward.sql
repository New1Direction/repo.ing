-- Forward repair: production already recorded collection migration timestamp 1792063200000.
-- Drizzle skips the older Hook Lab 0077 there. Preserve applied records and create the same
-- idempotent recipe tables after that timestamp; fresh databases have already run 0077.
-- Additive recipe storage. Production application requires the owner backup/migration gate.
-- Text preserves serialized JSON exactly (including key order and escaped Unicode).
-- Validate versions in the store on both write AND read. JSON field extraction in
-- PostgreSQL rejects otherwise legal escaped NUL/unpaired-surrogate JSON strings.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hook_lab_recipe_drafts (
  id uuid PRIMARY KEY,
  github_user_id bigint NOT NULL CHECK (github_user_id > 0),
  revision integer NOT NULL CHECK (revision > 0),
  envelope text NOT NULL CHECK (octet_length(envelope) <= 65536),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (json_typeof(envelope::json) = 'object')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hook_lab_recipe_drafts_user ON hook_lab_recipe_drafts(github_user_id, updated_at DESC);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hook_lab_recipe_events (
  id bigserial PRIMARY KEY,
  github_user_id bigint NOT NULL CHECK (github_user_id > 0),
  draft_id uuid NOT NULL REFERENCES hook_lab_recipe_drafts(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  action text NOT NULL CHECK (action = 'save'),
  envelope text NOT NULL CHECK (octet_length(envelope) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(draft_id, revision),
  CHECK (json_typeof(envelope::json) = 'object')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hook_lab_recipe_events_user ON hook_lab_recipe_events(github_user_id, created_at DESC);
