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
  evidence_conflict boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz
);
CREATE TABLE hook_lab_curve_events (
  journal_id uuid NOT NULL REFERENCES hook_lab_curve_journal(id),
  sequence bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('prepared','wallet-proof','partial-signatures','observation')),
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
-- Budget reservations are durable even while execution is hard-disabled. No expiry releases funds.
CREATE TABLE hook_lab_curve_trials (
  id uuid PRIMARY KEY,
  github_user_id bigint NOT NULL CHECK (github_user_id > 0),
  proposal jsonb NOT NULL,
  buy_plan jsonb NOT NULL,
  sell_plan jsonb NOT NULL,
  stopped boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hook_lab_curve_reservations (
  trial_id uuid NOT NULL REFERENCES hook_lab_curve_trials(id),
  side text NOT NULL CHECK (side IN ('buy','sell')),
  journal_id uuid NOT NULL UNIQUE REFERENCES hook_lab_curve_journal(id),
  input_amount numeric(20,0) NOT NULL CHECK (input_amount > 0),
  network_fee_cap numeric(20,0) NOT NULL CHECK (network_fee_cap >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trial_id, side)
);
-- A proof authorizes only retaining a curve review, never spending or a persistent wallet link.
CREATE TABLE hook_lab_curve_challenges (
  nonce text PRIMARY KEY CHECK (nonce ~ '^[a-f0-9]{48}$'),
  journal_id uuid NOT NULL,
  github_user_id bigint NOT NULL CHECK (github_user_id > 0),
  session_sha256 text NOT NULL,
  origin text NOT NULL,
  plan jsonb NOT NULL CHECK (pg_column_size(plan) <= 65536),
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hook_lab_curve_challenge_quota ON hook_lab_curve_challenges(github_user_id,created_at);

-- Operator acknowledgement/escalation is evidence, not delivery certainty or trading permission.
CREATE TABLE hook_lab_curve_alert_reviews (
  journal_id uuid NOT NULL,
  sequence bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('acknowledged','escalated')),
  operator_github_user_id bigint NOT NULL CHECK (operator_github_user_id > 0),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (journal_id,sequence,kind),
  FOREIGN KEY (journal_id,sequence) REFERENCES hook_lab_curve_alerts(journal_id,sequence)
);
