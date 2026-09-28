CREATE TABLE "agent_request_limits" (
  "scope" text PRIMARY KEY,
  "hits" integer NOT NULL CHECK ("hits" > 0),
  "expires_at" timestamptz NOT NULL
);
CREATE INDEX "agent_request_limits_expiry" ON "agent_request_limits" ("expires_at");
