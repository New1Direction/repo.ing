-- Bounded accounting roles. Apply only after review; provision encrypted logins separately.
-- No signing material, beneficiary mutation, claim/collection/payout writes, or existing grants change.
BEGIN;
CREATE ROLE repoing_ledger_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE repoing_fee_indexer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE repoing_ledger_reader SET default_transaction_read_only=on;
ALTER ROLE repoing_ledger_reader SET search_path=pg_catalog,public;
ALTER ROLE repoing_fee_indexer SET search_path=pg_catalog,public;
ALTER ROLE repoing_ledger_reader SET statement_timeout='15s';
ALTER ROLE repoing_fee_indexer SET statement_timeout='15s';
ALTER ROLE repoing_ledger_reader SET lock_timeout='2s';
ALTER ROLE repoing_fee_indexer SET lock_timeout='2s';
ALTER ROLE repoing_ledger_reader SET idle_in_transaction_session_timeout='15s';
ALTER ROLE repoing_fee_indexer SET idle_in_transaction_session_timeout='15s';
GRANT USAGE ON SCHEMA public TO repoing_ledger_reader,repoing_fee_indexer;
GRANT SELECT ON public.markets,public.builder_fee_credits,public.graduated_migration_proofs TO repoing_ledger_reader;
GRANT SELECT(github_repo_id,status,amount_base_units,damm_amount_base_units,evidence_source) ON public.repo_claims TO repoing_ledger_reader;
GRANT SELECT(github_repo_id,status,amount,receipt) ON public.builder_fee_collections TO repoing_ledger_reader;
GRANT SELECT(github_repo_id,amount_base_units) ON public.platform_fee_events TO repoing_ledger_reader;
GRANT SELECT(github_repo_id,phase,status,amount) ON public.platform_fee_claims TO repoing_ledger_reader;
GRANT SELECT(signature,item_index,github_repo_id,role,phase,amount) ON public.custody_fee_collections TO repoing_ledger_reader;
GRANT SELECT(collection_signature,collection_item_index,amount) ON public.custody_fee_payouts TO repoing_ledger_reader;

GRANT SELECT ON public.markets,public.graduated_migration_proofs TO repoing_fee_indexer;
GRANT SELECT,INSERT ON public.fee_events,public.discovery_fee_events,public.damm_fee_events,public.platform_fee_events TO repoing_fee_indexer;
GRANT SELECT,INSERT ON public.pool_fee_cursors TO repoing_fee_indexer;
GRANT UPDATE(last_signature,last_slot,updated_at) ON public.pool_fee_cursors TO repoing_fee_indexer;
GRANT USAGE ON SEQUENCE public.fee_events_id_seq,public.discovery_fee_events_id_seq,
  public.damm_fee_events_id_seq,public.platform_fee_events_id_seq TO repoing_fee_indexer;
DO $guard$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['repoing_ledger_reader','repoing_fee_indexer'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        AND c.relkind IN ('r','v','m','p','f') AND (
          (has_any_column_privilege(role_name,c.oid,'INSERT') AND NOT
            (role_name='repoing_fee_indexer' AND n.nspname='public' AND c.relname IN
              ('fee_events','discovery_fee_events','damm_fee_events','platform_fee_events','pool_fee_cursors'))) OR
          (has_any_column_privilege(role_name,c.oid,'UPDATE') AND NOT
            (role_name='repoing_fee_indexer' AND n.nspname='public' AND c.relname='pool_fee_cursors')) OR
          has_table_privilege(role_name,c.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES'))
    ) OR EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prosecdef
        AND has_function_privilege(role_name,p.oid,'EXECUTE')
    ) OR EXISTS (
      SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
        AND has_schema_privilege(role_name,n.oid,'CREATE')
    ) THEN RAISE EXCEPTION 'UNSAFE_ACCOUNTING_PRIVILEGES_REQUIRES_REVIEW'; END IF;
  END LOOP;
END $guard$;
COMMIT;
