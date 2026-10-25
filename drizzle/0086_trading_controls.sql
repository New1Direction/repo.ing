-- Expand-only. Instant trading switches the owner flips with one UPDATE; no row means the market group is off.
-- 'new_markets' gates trading on markets admitted by rule (src/new-market-trading.mjs), not the reviewed allowlist.
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS trading_controls (
  key varchar(32) PRIMARY KEY CHECK (key IN ('new_markets')),
  enabled boolean NOT NULL DEFAULT false,
  max_buy_lamports bigint NOT NULL CHECK (max_buy_lamports > 0),
  daily_buy_lamports bigint NOT NULL CHECK (daily_buy_lamports >= max_buy_lamports),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS trade_outcomes_submitted_buys ON trade_outcomes (created_at)
  WHERE outcome = 'submitted' AND direction = 'buy';
