-- Restricted role for scripts/collect-legacy-partner-fees.mjs. Run once as the database owner.
-- It can read what the DBC partner-fee collector reads and record only its own claims; nothing else.
-- Replace REPLACE_WITH_GENERATED_PASSWORD with the output of `openssl rand -base64 32` before running.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE ROLE repoing_partner_collector LOGIN PASSWORD 'REPLACE_WITH_GENERATED_PASSWORD'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
GRANT USAGE ON SCHEMA public TO repoing_partner_collector;
GRANT SELECT ON public.markets, public.discovery_fee_events, public.discovery_claims TO repoing_partner_collector;
GRANT SELECT, INSERT, UPDATE ON public.platform_fee_claims TO repoing_partner_collector;
GRANT USAGE, SELECT ON SEQUENCE public.platform_fee_claims_id_seq TO repoing_partner_collector;
ALTER ROLE repoing_partner_collector SET statement_timeout = '15s';
ALTER ROLE repoing_partner_collector SET idle_in_transaction_session_timeout = '30s';
COMMIT;
