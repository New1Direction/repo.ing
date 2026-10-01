-- Launch reviews awaiting the launcher's wallet signature (see src/launch-sessions.mjs). Replaces the per-process map in
-- app/api/launch/route.js so a launch prepared on one web replica can be submitted (or cancelled) on another.
-- Rows live for 2 minutes (expires_at, set from the database clock) and are consumed once: submit/cancel claim the row
-- with UPDATE ... WHERE consumed_at IS NULL, so exactly one request wins. "transaction" is the unsigned launch transaction
-- the wallet reviews (public). "mint_secret" is the fresh mint keypair's secret key, AES-256-GCM sealed with a key derived
-- from the platform creator secret (never stored in clear), and is erased when the row is consumed. Expired or consumed
-- rows are deleted by the web service and the worker; an expired review's still-'prepared' market is marked 'failed'.
CREATE TABLE "launch_sessions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "market_id" integer NOT NULL REFERENCES "markets"("id") ON DELETE CASCADE,
  "github_repo_id" bigint NOT NULL,
  "repo_full_name" text NOT NULL,
  "mint" varchar(44) NOT NULL,
  "launcher_wallet" varchar(44) NOT NULL,
  "config" varchar(44) NOT NULL,
  "transaction" text NOT NULL,
  "mint_secret" text,
  "blockhash" varchar(44) NOT NULL,
  "last_valid_block_height" bigint NOT NULL,
  "initial_buy_lamports" numeric(20, 0) NOT NULL DEFAULT 0 CHECK ("initial_buy_lamports" >= 0),
  "trend_revision" integer CHECK ("trend_revision" IS NULL OR "trend_revision" > 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  CONSTRAINT "launch_sessions_secret_check" CHECK (("consumed_at" IS NULL) = ("mint_secret" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX launch_sessions_open_market ON launch_sessions(market_id) WHERE consumed_at IS NULL;
--> statement-breakpoint
CREATE INDEX launch_sessions_expires_at ON launch_sessions(expires_at);
