-- Read-only role for fee reconciliation reports. Run once as the database owner.
-- Replace REPLACE_WITH_GENERATED_PASSWORD with the output of `openssl rand -hex 32` before running.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE ROLE repoing_reconcile_reader LOGIN PASSWORD 'REPLACE_WITH_GENERATED_PASSWORD'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
GRANT CONNECT ON DATABASE repoing_operational TO repoing_reconcile_reader;
GRANT USAGE ON SCHEMA public TO repoing_reconcile_reader;
GRANT SELECT ON public.markets, public.repositories, public.builder_fee_credits, public.repo_claims, public.builder_fee_collections,
  public.repo_beneficiaries, public.custody_collection_batches, public.custody_fee_collections, public.custody_fee_payouts,
  public.platform_fee_claims, public.repo_verifications TO repoing_reconcile_reader;
ALTER ROLE repoing_reconcile_reader SET default_transaction_read_only = on;
ALTER ROLE repoing_reconcile_reader SET statement_timeout = '15s';
COMMIT;
