-- Owner-applied recovery infrastructure, not part of app migrations.
-- Enable LOGIN separately with a fresh encrypted credential only after the privilege audit.
BEGIN;
CREATE ROLE repoing_chart_recovery NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE repoing_chart_recovery SET search_path=pg_catalog,public;
ALTER ROLE repoing_chart_recovery SET statement_timeout='15s';
ALTER ROLE repoing_chart_recovery SET lock_timeout='1s';
ALTER ROLE repoing_chart_recovery SET idle_in_transaction_session_timeout='10s';
CREATE SCHEMA recovery_charts;
REVOKE ALL ON SCHEMA recovery_charts FROM PUBLIC;
CREATE TABLE recovery_charts.cursors(pool varchar(44) PRIMARY KEY, signature varchar(88) NOT NULL,
  slot bigint NOT NULL, checked_at timestamptz NOT NULL DEFAULT now());
GRANT USAGE ON SCHEMA public,recovery_charts TO repoing_chart_recovery;
GRANT SELECT,INSERT,UPDATE ON recovery_charts.cursors TO repoing_chart_recovery;
GRANT SELECT ON public.markets,public.graduation_events,public.pool_fee_cursors TO repoing_chart_recovery;
GRANT SELECT,INSERT ON public.trade_events,public.damm_trade_events TO repoing_chart_recovery;
GRANT USAGE ON SEQUENCE public.trade_events_id_seq,public.damm_trade_events_id_seq TO repoing_chart_recovery;
-- Never grant UPDATE to the shared cursors, nor any access to signing/session/fee-credit tables.
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relkind IN ('r','v','m','p','f') AND (
        (has_table_privilege('repoing_chart_recovery',c.oid,'INSERT') AND NOT
          (n.nspname='public' AND c.relname IN ('trade_events','damm_trade_events') OR n.nspname='recovery_charts' AND c.relname='cursors')) OR
        (has_table_privilege('repoing_chart_recovery',c.oid,'UPDATE') AND NOT (n.nspname='recovery_charts' AND c.relname='cursors')) OR
        has_table_privilege('repoing_chart_recovery',c.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES'))
  ) OR EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prosecdef
      AND has_function_privilege('repoing_chart_recovery',p.oid,'EXECUTE')
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
      AND has_schema_privilege('repoing_chart_recovery',n.oid,'CREATE')
  ) THEN RAISE EXCEPTION 'UNSAFE_CHART_RECOVERY_PRIVILEGES'; END IF;
END $guard$;
COMMIT;
