-- Separate display observations; do not mark financial/operator graduation reconciliation verified.
BEGIN;
CREATE TABLE recovery_charts.observations(github_repo_id bigint PRIMARY KEY,checked_at timestamptz NOT NULL,observation text NOT NULL);
GRANT SELECT,INSERT,UPDATE ON recovery_charts.observations TO repoing_chart_recovery;
GRANT SELECT ON public.graduated_migration_proofs TO repoing_chart_recovery;
GRANT USAGE ON SCHEMA recovery_charts TO repoing_site_view_owner;
GRANT SELECT ON recovery_charts.observations TO repoing_site_view_owner;
SET LOCAL ROLE repoing_site_view_owner;
CREATE OR REPLACE VIEW site_public.graduation_observations WITH (security_barrier=true) AS
SELECT o.github_repo_id,o.checked_at,'VERIFIED'::varchar(32) AS status,o.observation,
  NULL::text AS reconciliation,NULL::text AS error_code
FROM recovery_charts.observations o JOIN site_public.markets m USING(github_repo_id);
RESET ROLE;
COMMIT;
