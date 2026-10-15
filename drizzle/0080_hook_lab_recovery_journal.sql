-- Inert candidate storage. Apply only after reviewed production backup/restore and migration approval.
-- Independent of expiring drafts: no FK/cascade to recipe tables, TTL, worker or public write route.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE hook_lab_recovery_journal (
  id uuid PRIMARY KEY,
  github_user_id bigint NOT NULL CHECK (github_user_id > 0),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  genesis_hash text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('launch','buy','sell')),
  mint text NOT NULL,
  message_sha256 text NOT NULL CHECK (message_sha256 ~ '^[a-f0-9]{64}$'),
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'object' AND pg_column_size(terms) <= 8192),
  status text NOT NULL CHECK (status IN ('prepared','unresolved')),
  signature text,
  signed_transaction text CHECK (octet_length(signed_transaction) <= 1644),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status='prepared' AND signature IS NULL AND signed_transaction IS NULL)
      OR (status='unresolved' AND signature IS NOT NULL AND signed_transaction IS NOT NULL)),
  UNIQUE(genesis_hash,message_sha256),
  UNIQUE(genesis_hash,signature)
);
--> statement-breakpoint
CREATE UNIQUE INDEX hook_lab_recovery_launch_mint ON hook_lab_recovery_journal(genesis_hash,mint) WHERE operation='launch';
--> statement-breakpoint
CREATE INDEX hook_lab_recovery_owner ON hook_lab_recovery_journal(github_user_id,created_at);
--> statement-breakpoint
CREATE TABLE hook_lab_recovery_events (
  id bigserial PRIMARY KEY,
  journal_id uuid NOT NULL REFERENCES hook_lab_recovery_journal(id),
  kind text NOT NULL CHECK (kind IN ('prepared','signed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(journal_id,kind)
);
