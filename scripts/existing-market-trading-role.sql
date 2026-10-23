-- REVIEW ONLY: separate production database-owner approval required.
-- No credentials or LOGIN, no migration, no historical replay, no owner changes.
BEGIN;
CREATE ROLE repoing_existing_market_trader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE repoing_existing_market_trader SET search_path = public, pg_catalog;
ALTER ROLE repoing_existing_market_trader SET statement_timeout = '10s';
ALTER ROLE repoing_existing_market_trader SET lock_timeout = '5s';
ALTER ROLE repoing_existing_market_trader SET idle_in_transaction_session_timeout = '10s';
GRANT USAGE ON SCHEMA public TO repoing_existing_market_trader;
GRANT SELECT ON public.markets, public.graduated_migration_proofs TO repoing_existing_market_trader;
GRANT SELECT, INSERT ON public.fee_events, public.discovery_fee_events,
  public.trade_outcomes, public.trade_referrers, public.graduation_alerts TO repoing_existing_market_trader;
GRANT SELECT, INSERT, DELETE ON public.trade_sessions TO repoing_existing_market_trader;
GRANT UPDATE (signature, signed_message, submitted_at, result) ON public.trade_sessions TO repoing_existing_market_trader;
GRANT USAGE ON SEQUENCE public.fee_events_id_seq, public.discovery_fee_events_id_seq,
  public.trade_outcomes_id_seq, public.graduation_alerts_id_seq TO repoing_existing_market_trader;
-- Do not accept inherited/public access to any other base table, schema writes,
-- or a security-definer function that could bypass this table-limited role.
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind IN ('r','v','m','p')
      AND c.relname NOT IN ('markets','graduated_migration_proofs','fee_events','discovery_fee_events',
        'trade_outcomes','trade_referrers','graduation_alerts','trade_sessions')
      AND (has_column_privilege('repoing_existing_market_trader',c.oid,a.attnum,'SELECT') OR
        has_column_privilege('repoing_existing_market_trader',c.oid,a.attnum,'INSERT') OR
        has_column_privilege('repoing_existing_market_trader',c.oid,a.attnum,'UPDATE') OR
        has_table_privilege('repoing_existing_market_trader',c.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES'))
  ) OR EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege('repoing_existing_market_trader',p.oid,'EXECUTE')
  ) OR has_schema_privilege('repoing_existing_market_trader','public','CREATE') THEN
    RAISE EXCEPTION 'UNSAFE_INHERITED_TRADING_PRIVILEGES_REQUIRES_OWNER_REVIEW';
  END IF;
END $guard$;
COMMIT;
