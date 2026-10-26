-- Restricted role for scripts/collect-vault-creator-fees.mjs. Run once as the database owner.
-- It can read what the custody ledger writer checks and insert only DBC collection receipts; nothing else.
-- Replace REPLACE_WITH_GENERATED_PASSWORD with the output of `openssl rand -hex 32` before running.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE ROLE repoing_custody_recorder LOGIN PASSWORD 'REPLACE_WITH_GENERATED_PASSWORD'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
-- Production revokes CONNECT from PUBLIC, so each login role is granted it explicitly.
GRANT CONNECT ON DATABASE repoing_operational TO repoing_custody_recorder;
GRANT USAGE ON SCHEMA public TO repoing_custody_recorder;
GRANT SELECT ON public.markets, public.repo_claims, public.builder_fee_collections, public.platform_fee_claims,
  public.custody_fee_payouts TO repoing_custody_recorder;
GRANT SELECT, INSERT ON public.custody_collection_batches, public.custody_fee_collections TO repoing_custody_recorder;
ALTER ROLE repoing_custody_recorder SET statement_timeout = '15s';
ALTER ROLE repoing_custody_recorder SET idle_in_transaction_session_timeout = '30s';
COMMIT;
