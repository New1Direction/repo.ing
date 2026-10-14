-- One latest worker-process observation, not a run history or a fleet census. No payloads or identifiers.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operator_worker_snapshot" (
  "id" smallint PRIMARY KEY CHECK ("id" = 1),
  "snapshot" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "launch_webhook_deliveries_failed_time" ON "launch_webhook_deliveries"("created_at" DESC) WHERE "status" = 'failed';
