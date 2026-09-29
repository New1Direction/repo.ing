-- Operator-only trade landing telemetry: one row per (attempt, outcome). Additive; nothing reads it for money.
-- attempt_key is the prepare session id (or sig:<signature> when the session is gone), so status polls,
-- retries and replicas cannot duplicate an outcome. No wallet or key material is stored.
CREATE TABLE "trade_outcomes" (
  "id" serial PRIMARY KEY NOT NULL,
  "attempt_key" varchar(100) NOT NULL,
  "outcome" varchar(24) NOT NULL CHECK ("outcome" IN ('prepared', 'submitted', 'confirmed', 'expired', 'failed', 'verification_failed')),
  "github_repo_id" bigint,
  "mint" varchar(44),
  "phase" varchar(16),
  "direction" varchar(4) CHECK ("direction" IS NULL OR "direction" IN ('buy', 'sell')),
  "amount_in" numeric(20, 0),
  "priority_fee_lamports" bigint,
  "cu_price_micro_lamports" bigint,
  "cu_limit" integer,
  "signature" varchar(88),
  "error" text,
  "prepare_to_sign_ms" integer,
  "sign_to_confirm_ms" integer,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX trade_outcomes_attempt_outcome_unique ON trade_outcomes(attempt_key, outcome);
--> statement-breakpoint
CREATE INDEX trade_outcomes_created_at ON trade_outcomes(created_at);
