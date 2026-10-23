-- REVIEW ONLY. Separate database-owner approval required; do not execute as part of tests/deploy.
-- Dedicated, append-only observations. These are NOT production credits, grants, or payouts.
-- No run-table FK: the six-step guard owns that table and its before-signing persistence.
BEGIN;
CREATE TABLE public.existing_market_test_damm_baselines (
  github_repo_id bigint PRIMARY KEY CHECK (github_repo_id > 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (snapshot->>'githubRepoId' = github_repo_id::text)
);
CREATE TABLE public.existing_market_test_damm_checkpoints (
  id uuid PRIMARY KEY,
  run_id text NOT NULL CHECK (length(btrim(run_id)) BETWEEN 1 AND 200),
  step smallint NOT NULL CHECK (step BETWEEN 1 AND 6),
  github_repo_id bigint NOT NULL REFERENCES public.existing_market_test_damm_baselines(github_repo_id),
  signature text NOT NULL UNIQUE CHECK (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  market_sequence bigint NOT NULL CHECK (market_sequence > 0),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  before_snapshot jsonb NOT NULL CHECK (jsonb_typeof(before_snapshot) = 'object'),
  after_snapshot jsonb NOT NULL CHECK (jsonb_typeof(after_snapshot) = 'object'),
  accounting_baseline jsonb NOT NULL CHECK (jsonb_typeof(accounting_baseline) = 'object'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step),
  UNIQUE (github_repo_id, market_sequence),
  CHECK (before_snapshot->>'githubRepoId' = github_repo_id::text),
  CHECK (after_snapshot->>'githubRepoId' = github_repo_id::text),
  CHECK (accounting_baseline->>'githubRepoId' = github_repo_id::text)
);
COMMENT ON TABLE public.existing_market_test_damm_baselines IS
  'First finalized observations: historical earned/claimed/available remain reserved, never credited by the test.';
COMMENT ON TABLE public.existing_market_test_damm_checkpoints IS
  'Interval observations, not exclusive swap attribution. result deltas span previous after to current after; gap and observed subinterval are separate.';
REVOKE ALL ON public.existing_market_test_damm_baselines, public.existing_market_test_damm_checkpoints FROM PUBLIC;
REVOKE ALL ON public.existing_market_test_damm_baselines, public.existing_market_test_damm_checkpoints FROM repoing_existing_market_trader;
GRANT SELECT, INSERT ON public.existing_market_test_damm_baselines, public.existing_market_test_damm_checkpoints TO repoing_existing_market_trader;
GRANT SELECT ON public.graduated_migration_proofs TO repoing_existing_market_trader;
-- No UPDATE/DELETE/TRUNCATE, sequence grants, production ledger privileges, or function EXECUTE grants.
COMMIT;
