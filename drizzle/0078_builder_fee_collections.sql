-- Operator-reviewed withdrawals of builder entitlement; never an owner payout or partner revenue.
CREATE TABLE builder_fee_collections (
  id uuid PRIMARY KEY,
  github_repo_id bigint NOT NULL REFERENCES repositories(github_repo_id),
  mint varchar(44) NOT NULL,
  pool varchar(44) NOT NULL,
  wallet varchar(44) NOT NULL,
  amount numeric(20,0) NOT NULL CHECK (amount > 0),
  status text NOT NULL CHECK (status IN ('reviewed','pending','settled','aborted')),
  terms text NOT NULL,
  terms_hash varchar(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  signature varchar(88) UNIQUE,
  signed_transaction text,
  last_valid_block_height bigint,
  receipt text,
  settled_at timestamptz,
  resolved_at timestamptz,
  resolution_reason text,
  CHECK (status NOT IN ('pending','settled') OR (signature IS NOT NULL AND signed_transaction IS NOT NULL AND last_valid_block_height IS NOT NULL)),
  CHECK ((status='settled') = (settled_at IS NOT NULL)),
  CHECK ((status='aborted') = (resolved_at IS NOT NULL)),
  CHECK (status <> 'settled' OR receipt IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX builder_fee_collections_one_pending_per_repo ON builder_fee_collections(github_repo_id) WHERE status='pending';
--> statement-breakpoint
CREATE INDEX builder_fee_collections_repo_status ON builder_fee_collections(github_repo_id,status);
