-- REVIEW ONLY. A database owner must approve/apply this separately; NOT a migration or deployment step.
-- Prerequisites: existing trend tables/defaults/unique indexes (0017), repository_participation,
-- maintainer_invites and maintainer_opt_outs (0041). Use the currently migrated application schema.
-- No LOGIN, passwords, membership grants, default privilege changes, historical replay or financial writes here.
-- Provision a NEW login separately, with only CONNECT and SET ROLE membership in this role, no object ownership,
-- superuser/CREATEROLE/BYPASSRLS/other memberships or broad inherited grants. Supply ONLY its URL as
-- PUBLIC_DISCOVERY_DATABASE_URL; do not copy the omnibus worker's environment or use its credentials.
-- The command explicitly sets this role and search_path per connection (role defaults are not inherited by SET ROLE).
-- PUBLIC grants cannot be removed for one role. This script FAILS CLOSED rather than changing shared privileges.
-- Before deploying, also audit the login, database extensions, default ACLs, and future grants/trigger changes.
BEGIN;
CREATE ROLE repoing_public_discovery NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE repoing_public_discovery SET search_path = pg_catalog, public;
ALTER ROLE repoing_public_discovery SET statement_timeout = '5s';
ALTER ROLE repoing_public_discovery SET lock_timeout = '1s';
ALTER ROLE repoing_public_discovery SET idle_in_transaction_session_timeout = '10s';
GRANT USAGE ON SCHEMA public TO repoing_public_discovery;

-- Candidates are created as detected/revision 0 by the schema, never approved/enrolled by discovery.
GRANT SELECT (github_repo_id, full_name, description, observed_at, state, attempted_at, detected_at),
  INSERT (github_repo_id, full_name, description, observed_at),
  UPDATE (full_name, description, observed_at, attempted_at, error)
  ON public.trend_candidates TO repoing_public_discovery;
GRANT SELECT (github_repo_id, observed_at), INSERT (github_repo_id, observed_at, evidence, evidence_hash)
  ON public.trend_observations TO repoing_public_discovery;
GRANT SELECT (github_repo_id, source, url, note, occurred_at, expires_at),
  INSERT (github_repo_id, source, url, note, occurred_at, expires_at), UPDATE (note, occurred_at, expires_at)
  ON public.trend_signals TO repoing_public_discovery;
GRANT SELECT (source, status, checked_at, detail), INSERT (source, status, detail), UPDATE (status, checked_at, detail)
  ON public.trend_source_health TO repoing_public_discovery;
GRANT USAGE ON SEQUENCE public.trend_observations_id_seq, public.trend_signals_id_seq TO repoing_public_discovery;

-- Read-only policy joins; no maintainer identities, notes, wallets, market/launch/reward/alert tables needed.
GRANT SELECT (github_repo_id, withdrawn_at) ON public.maintainer_opt_outs TO repoing_public_discovery;
GRANT SELECT (github_repo_id, enabled) ON public.repository_participation TO repoing_public_discovery;
GRANT SELECT (github_repo_id, dismissed_at) ON public.maintainer_invites TO repoing_public_discovery;

DO $guard$
BEGIN
  IF EXISTS (
    WITH allowed(name, reads, inserts, updates) AS (VALUES
      ('trend_candidates', ARRAY['github_repo_id','full_name','description','observed_at','state','attempted_at','detected_at'],
        ARRAY['github_repo_id','full_name','description','observed_at'], ARRAY['full_name','description','observed_at','attempted_at','error']),
      ('trend_observations', ARRAY['github_repo_id','observed_at'], ARRAY['github_repo_id','observed_at','evidence','evidence_hash'], ARRAY[]::text[]),
      ('trend_signals', ARRAY['github_repo_id','source','url','note','occurred_at','expires_at'],
        ARRAY['github_repo_id','source','url','note','occurred_at','expires_at'], ARRAY['note','occurred_at','expires_at']),
      ('trend_source_health', ARRAY['source','status','checked_at','detail'], ARRAY['source','status','detail'], ARRAY['status','checked_at','detail']),
      ('maintainer_opt_outs', ARRAY['github_repo_id','withdrawn_at'], ARRAY[]::text[], ARRAY[]::text[]),
      ('repository_participation', ARRAY['github_repo_id','enabled'], ARRAY[]::text[], ARRAY[]::text[]),
      ('maintainer_invites', ARRAY['github_repo_id','dismissed_at'], ARRAY[]::text[], ARRAY[]::text[])
    )
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN allowed x ON n.nspname='public' AND x.name=c.relname
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND c.relkind IN ('r','v','m','p','f') AND (
        (has_column_privilege('repoing_public_discovery',c.oid,a.attnum,'SELECT') AND NOT coalesce(a.attname=ANY(x.reads),false)) OR
        (has_column_privilege('repoing_public_discovery',c.oid,a.attnum,'INSERT') AND NOT coalesce(a.attname=ANY(x.inserts),false)) OR
        (has_column_privilege('repoing_public_discovery',c.oid,a.attnum,'UPDATE') AND NOT coalesce(a.attname=ANY(x.updates),false)) OR
        has_table_privilege('repoing_public_discovery',c.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES'))
  ) OR EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='S' AND n.nspname NOT IN ('pg_catalog','information_schema') AND (
      has_sequence_privilege('repoing_public_discovery',c.oid,'SELECT,UPDATE') OR
      (has_sequence_privilege('repoing_public_discovery',c.oid,'USAGE') AND NOT
        (n.nspname='public' AND c.relname IN ('trend_observations_id_seq','trend_signals_id_seq'))))
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
      AND has_schema_privilege('repoing_public_discovery',n.oid,'CREATE')
  ) OR EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prosecdef
      AND has_function_privilege('repoing_public_discovery',p.oid,'EXECUTE')
  ) OR EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('trend_candidates','trend_observations','trend_signals','trend_source_health')
      AND NOT t.tgisinternal AND t.tgenabled <> 'D'
  ) OR EXISTS (
    SELECT 1 FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('trend_candidates','trend_observations','trend_signals','trend_source_health')
      AND r.rulename <> '_RETURN'
  ) THEN
    RAISE EXCEPTION 'UNSAFE_PUBLIC_DISCOVERY_PRIVILEGES_REQUIRES_OWNER_REVIEW';
  END IF;
END $guard$;
COMMIT;
