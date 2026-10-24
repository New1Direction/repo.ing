-- REVIEW ONLY. Separate owner approval is required before applying this role/grants.
-- Ordinary no-buy launch persistence only; no login credential, signing key,
-- accounting write, claim, payout, bundle mutation or Hook permission is created.
BEGIN;
CREATE ROLE repoing_ordinary_launcher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE repoing_ordinary_launcher SET search_path = public, pg_catalog;
ALTER ROLE repoing_ordinary_launcher SET statement_timeout = '10s';
ALTER ROLE repoing_ordinary_launcher SET lock_timeout = '5s';
ALTER ROLE repoing_ordinary_launcher SET idle_in_transaction_session_timeout = '10s';
GRANT USAGE ON SCHEMA public TO repoing_ordinary_launcher;
GRANT SELECT, INSERT, UPDATE ON public.repositories, public.markets TO repoing_ordinary_launcher;
GRANT SELECT, INSERT, DELETE ON public.launch_sessions TO repoing_ordinary_launcher;
GRANT UPDATE (consumed_at, mint_secret) ON public.launch_sessions TO repoing_ordinary_launcher;
GRANT SELECT ON public.bundles, public.launch_schedules, public.maintainer_opt_outs TO repoing_ordinary_launcher;
GRANT SELECT (github_repo_id, permission) ON public.repo_verifications TO repoing_ordinary_launcher;
GRANT SELECT (github_repo_id) ON public.repo_beneficiaries TO repoing_ordinary_launcher;
GRANT USAGE ON SEQUENCE public.markets_id_seq TO repoing_ordinary_launcher;
-- Refuse unexpected inherited/public permissions; do not silently broaden the runtime.
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relkind IN ('r','v','m','p','f') AND (
        (has_column_privilege('repoing_ordinary_launcher',c.oid,a.attnum,'SELECT') AND NOT
          (n.nspname='public' AND c.relname IN ('repositories','markets','launch_sessions','bundles','launch_schedules',
            'maintainer_opt_outs','repo_verifications','repo_beneficiaries'))) OR
        (has_column_privilege('repoing_ordinary_launcher',c.oid,a.attnum,'INSERT,UPDATE') AND NOT
          (n.nspname='public' AND c.relname IN ('repositories','markets','launch_sessions'))) OR
        (has_table_privilege('repoing_ordinary_launcher',c.oid,'DELETE') AND NOT
          (n.nspname='public' AND c.relname='launch_sessions')) OR
        has_table_privilege('repoing_ordinary_launcher',c.oid,'TRUNCATE,TRIGGER,REFERENCES'))
  ) OR EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prosecdef
      AND has_function_privilege('repoing_ordinary_launcher',p.oid,'EXECUTE')
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
      AND has_schema_privilege('repoing_ordinary_launcher',n.oid,'CREATE')
  ) THEN RAISE EXCEPTION 'UNSAFE_INHERITED_LAUNCH_PRIVILEGES_REQUIRES_OWNER_REVIEW'; END IF;
END $guard$;
COMMIT;
