-- REVIEW ONLY: apply to production only with separate test-only database approval.
BEGIN;
CREATE TABLE public.existing_market_test_runs (
  id text PRIMARY KEY CHECK (id = 'existing-markets-six-swaps-v1'),
  enabled boolean NOT NULL DEFAULT false,
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object')
);
INSERT INTO public.existing_market_test_runs (id, state) VALUES
  ('existing-markets-six-swaps-v1', '{"phase":"ready","step":0,"spent":"0","acquired":null,"pending":null,"history":[]}');
REVOKE ALL ON public.existing_market_test_runs FROM PUBLIC, repoing_existing_market_trader;
GRANT SELECT, UPDATE(state) ON public.existing_market_test_runs TO repoing_existing_market_trader;
-- No INSERT/DELETE, approval-column update, reset procedure or automatic enabling.
COMMIT;
