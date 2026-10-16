-- Off-chain preparation proof only. Shared migration requires separate approval.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE hook_lab_plain_challenges (
  nonce text PRIMARY KEY CHECK (nonce ~ '^[a-f0-9]{48}$'),
  github_user_id bigint NOT NULL CHECK (github_user_id > 0),
  session_hash text NOT NULL CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  origin text NOT NULL,
  operation_id uuid NOT NULL,
  wallet text NOT NULL,
  genesis_hash text NOT NULL,
  profile_sha256 text NOT NULL CHECK (profile_sha256 ~ '^[a-f0-9]{64}$'),
  message_sha256 text NOT NULL CHECK (message_sha256 ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  proof_signature text CHECK (octet_length(proof_signature) = 88),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((consumed_at IS NULL) = (proof_signature IS NULL))
);
--> statement-breakpoint
CREATE INDEX hook_lab_plain_challenge_owner ON hook_lab_plain_challenges(github_user_id,created_at);
