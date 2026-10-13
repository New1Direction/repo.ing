-- Maintainer claim funnel events (src/funnel-store.mjs, docs/CLAIM_FUNNEL.md): an event name, an optional source and
-- outcome from fixed lists, and an optional public repository id. Nothing identifies a person: no login, wallet, cookie,
-- URL or IP. Rows older than 180 days are deleted by the web service. Expand-only and idempotent.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "funnel_events" (
  "id" bigserial PRIMARY KEY,
  "event" varchar(24) NOT NULL CHECK ("event" IN ('claim_view', 'builders_view', 'waiting_view', 'verify_start', 'app_access_required',
    'verify_result', 'builders_connect', 'builders_result', 'owner_lookup')),
  "source" varchar(16) CHECK ("source" IN ('waiting', 'x', 'invite', 'share', 'token', 'builders', 'lookup', 'admin')),
  "repo_id" bigint CHECK ("repo_id" BETWEEN 1 AND 4503599627370495),
  "outcome" varchar(16) CHECK ("outcome" IN ('verified', 'not-admin', 'cancelled', 'failed', 'found', 'none')),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "funnel_events_created_at" ON "funnel_events"("created_at");
