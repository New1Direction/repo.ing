-- Candidate schema only: NOT a registered/shared migration. Consumer owns migration 0082.
-- Integration must allocate a migration number and approve backup/restore before applying.
CREATE TABLE hook_lab_curve_journal (
  id uuid PRIMARY KEY,
  github_user_id bigint NOT NULL CHECK (github_user_id > 0),
  message_sha256 text NOT NULL UNIQUE CHECK (message_sha256 ~ '^[a-f0-9]{64}$'),
  plan jsonb NOT NULL CHECK (pg_column_size(plan) <= 65536),
  partial_transaction text CHECK (octet_length(partial_transaction) <= 1644),
  complete boolean NOT NULL DEFAULT false,
  latest_status text NOT NULL DEFAULT 'prepared',
  first_finalized jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz
);
CREATE TABLE hook_lab_curve_events (
  journal_id uuid NOT NULL REFERENCES hook_lab_curve_journal(id),
  sequence bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('prepared','partial-signatures','observation')),
  evidence jsonb NOT NULL CHECK (pg_column_size(evidence) <= 262144),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (journal_id, sequence)
);
CREATE TABLE hook_lab_curve_alerts (
  journal_id uuid NOT NULL,
  sequence bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','unknown')),
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  message_id text,
  PRIMARY KEY (journal_id, sequence),
  FOREIGN KEY (journal_id, sequence) REFERENCES hook_lab_curve_events(journal_id, sequence)
);
