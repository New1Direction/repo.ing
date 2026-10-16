-- Disabled production candidate. Shared application requires separate backup/migration approval.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE hook_lab_plain_recovery (
  id uuid PRIMARY KEY,
  github_user_id bigint NOT NULL CHECK (github_user_id > 0),
  genesis_hash text NOT NULL,
  mint text NOT NULL,
  message_sha256 text NOT NULL CHECK (message_sha256 ~ '^[a-f0-9]{64}$'),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object' AND pg_column_size(plan) <= 65536),
  signature text,
  signed_transaction text CHECK (octet_length(signed_transaction) <= 1644),
  observation jsonb,
  retained_receipt jsonb,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((signature IS NULL) = (signed_transaction IS NULL)),
  UNIQUE(genesis_hash,mint),
  UNIQUE(genesis_hash,message_sha256),
  UNIQUE(genesis_hash,signature)
);
--> statement-breakpoint
CREATE INDEX hook_lab_plain_owner ON hook_lab_plain_recovery(github_user_id,created_at);
--> statement-breakpoint
CREATE TABLE hook_lab_plain_events (
  id bigserial PRIMARY KEY,
  journal_id uuid NOT NULL REFERENCES hook_lab_plain_recovery(id),
  kind text NOT NULL CHECK (kind IN ('prepared','signed','observed')),
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
