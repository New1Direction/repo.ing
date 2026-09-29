-- Prepared trade sessions that survive deploys and span replicas (see src/trade-sessions.mjs). Rows are short-lived:
-- the web service deletes them 10 minutes after prepare. record holds the trader's plain prepared record (unsigned
-- transaction, reviewed message, amounts, blockhash window, pool/vault/mint/referral pins). No key material.
CREATE TABLE "trade_sessions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "wallet" varchar(44) NOT NULL,
  "phase" varchar(16) NOT NULL CHECK ("phase" IN ('curve', 'graduated')),
  "direction" varchar(4) NOT NULL CHECK ("direction" IN ('buy', 'sell')),
  "github_repo_id" bigint NOT NULL,
  "transaction" text NOT NULL,
  "message" text NOT NULL,
  "amount_in" numeric(20, 0) NOT NULL,
  "minimum_amount_out" numeric(20, 0) NOT NULL,
  "blockhash" varchar(44) NOT NULL,
  "last_valid_block_height" bigint NOT NULL,
  "record" jsonb NOT NULL,
  "signature" varchar(88),
  "signed_message" text,
  "submitted_at" timestamptz,
  "result" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX trade_sessions_created_at ON trade_sessions(created_at);
--> statement-breakpoint
-- Operator-only trade canary: the worker's latest simulated (never signed or sent) 0.01 SOL buy per market.
CREATE TABLE "trade_canary_status" (
  "github_repo_id" bigint PRIMARY KEY NOT NULL,
  "symbol" varchar(16),
  "phase" varchar(16),
  "ok" boolean NOT NULL,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "detail" jsonb,
  "last_run_at" timestamptz NOT NULL,
  "last_ok_at" timestamptz
);
