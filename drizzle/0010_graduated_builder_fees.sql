CREATE TABLE damm_fee_events (
  id serial PRIMARY KEY,
  github_repo_id bigint NOT NULL REFERENCES repositories(github_repo_id),
  pool varchar(44) NOT NULL,
  position varchar(44) NOT NULL,
  slot bigint NOT NULL,
  amount_base_units bigint NOT NULL CHECK (amount_base_units > 0),
  cumulative_earned bigint NOT NULL CHECK (cumulative_earned > 0),
  cumulative_claimed bigint NOT NULL CHECK (cumulative_claimed >= 0 AND cumulative_claimed <= cumulative_earned),
  evidence_hash varchar(64) NOT NULL,
  evidence text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (position, cumulative_earned)
);
--> statement-breakpoint
ALTER TABLE repo_claims ADD COLUMN signed_transaction text,
  ADD COLUMN last_valid_block_height bigint,
  ADD COLUMN damm_amount_base_units bigint NOT NULL DEFAULT 0 CHECK (damm_amount_base_units >= 0 AND damm_amount_base_units <= amount_base_units);
--> statement-breakpoint
CREATE VIEW builder_fee_credits AS
  SELECT github_repo_id, pool, amount_base_units, asset FROM fee_events
  UNION ALL
  SELECT d.github_repo_id, m.pool, d.amount_base_units, 'So11111111111111111111111111111111111111112'::varchar AS asset
  FROM damm_fee_events d JOIN markets m ON m.github_repo_id=d.github_repo_id;
