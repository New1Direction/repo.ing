-- The sign-in handoff for repo.ing AI credits (src/repo-inference-handoff.mjs): one row per approved handoff, holding a
-- single-use code's hash (never the code), the CLI's PKCE challenge, who repo.ing confirmed as an admin of which
-- repository and when. A code lives 3 minutes and is consumed by its first redemption. Expand-only and idempotent.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_handoffs" (
  "handoff_id" varchar(32) PRIMARY KEY,
  "code_hash" char(64) NOT NULL UNIQUE,
  "audience" varchar(32) NOT NULL,
  "github_repo_id" bigint NOT NULL,
  "github_user_id" bigint NOT NULL,
  "github_login" varchar(39) NOT NULL,
  "code_challenge" varchar(43) NOT NULL,
  "verified_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  CONSTRAINT "auth_handoffs_audience_check" CHECK ("audience" IN ('repo-inference')),
  CONSTRAINT "auth_handoffs_code_check" CHECK ("code_hash" ~ '^[0-9a-f]{64}$' AND "code_challenge" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "auth_handoffs_ids_check" CHECK ("github_repo_id" > 0 AND "github_user_id" > 0 AND "handoff_id" ~ '^[A-Za-z0-9_-]{16,32}$'),
  CONSTRAINT "auth_handoffs_expiry_check" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '10 minutes')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_handoffs_expires_idx" ON "auth_handoffs" ("expires_at");
