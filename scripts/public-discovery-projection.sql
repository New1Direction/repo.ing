-- REVIEW ONLY: separate database-owner approval/application required. PostgreSQL 16+ (IS JSON).
-- Restores ONLY the four typed-empty discovery views from the 2026-10-22 public-reader projection.
-- No reader role/login/credential/search_path/read-only changes; no base-table grants to the reader.
-- CREATE OR REPLACE preserves view OIDs, owners, ACLs, names, column types and ordering. Do NOT DROP views.
-- trend_launches, trend_reviews and trend_alerts stay typed-empty. Approval metadata is always NULL;
-- approved/reviewed candidates appear as detected, so discovery cannot imply launch/reward authorization.
-- Public JSON is rebuilt field-by-field: no raw evidence/sources, manual notes, operators, or health detail.
-- Existing markets projection hides pending markets and bundles/participation/invites are empty; filter those
-- exclusions against base tables HERE, rather than accidentally advertising an in-progress/declined launch.
-- PROMOTION_EXCLUDED_REPO_IDS remains an application-level filter and must match the discovery scheduler.
BEGIN;
DO $preflight$
BEGIN
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='site_public' AND c.relname IN ('trend_candidates','trend_observations','trend_signals','trend_source_health')
        AND c.relkind='v' AND c.relowner='repoing_site_view_owner'::regrole
        AND coalesce(c.reloptions @> ARRAY['security_barrier=true'],false)
        AND NOT coalesce(c.reloptions @> ARRAY['security_invoker=true'],false)) <> 4 THEN
    RAISE EXCEPTION 'PUBLIC_DISCOVERY_PROJECTION_BASELINE_REQUIRED';
  END IF;
END $preflight$;

GRANT SELECT (github_repo_id,full_name,description,state,observed_at,detected_at,error)
  ON public.trend_candidates TO repoing_site_view_owner;
GRANT SELECT (github_repo_id,observed_at,evidence) ON public.trend_observations TO repoing_site_view_owner;
GRANT SELECT (id,github_repo_id,source,url,occurred_at,expires_at) ON public.trend_signals TO repoing_site_view_owner;
GRANT SELECT (source,status,checked_at) ON public.trend_source_health TO repoing_site_view_owner;
GRANT SELECT (github_repo_id,withdrawn_at) ON public.maintainer_opt_outs TO repoing_site_view_owner;
GRANT SELECT (github_repo_id,enabled) ON public.repository_participation TO repoing_site_view_owner;
GRANT SELECT (github_repo_id,dismissed_at) ON public.maintainer_invites TO repoing_site_view_owner;
GRANT SELECT (github_repo_id,archived) ON public.repositories TO repoing_site_view_owner;
GRANT SELECT (github_repo_id,status,indexed_at,launch_finality) ON public.markets TO repoing_site_view_owner;
GRANT SELECT (github_repo_id,status) ON public.bundles TO repoing_site_view_owner;

-- Requires SET ROLE permission for the existing view owner; ADMIN membership alone is insufficient.
-- Replace views as their existing owner without adding schema privileges to the login.
SET LOCAL ROLE repoing_site_view_owner;

CREATE OR REPLACE VIEW site_public.trend_candidates WITH (security_barrier=true) AS
SELECT c.github_repo_id,c.full_name,c.description,
  (CASE WHEN c.state IN ('reviewed','approved') THEN 'detected' ELSE c.state END)::varchar(16) AS state,
  NULL::integer AS revision,c.observed_at,NULL::timestamptz AS attempted_at,c.detected_at,NULL::text AS error,
  NULL::varchar(44) AS approved_config,NULL::integer AS approved_discovery_version,
  NULL::bigint AS approved_window_ms,NULL::timestamptz AS approved_at
FROM public.trend_candidates c
WHERE c.state NOT IN ('rejected','duplicate') AND c.error IS NULL
  AND c.observed_at >= now()-interval '6 hours' AND c.observed_at <= now()+interval '1 minute'
  AND NOT EXISTS (SELECT 1 FROM public.maintainer_opt_outs o WHERE o.github_repo_id=c.github_repo_id AND o.withdrawn_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM public.repository_participation p WHERE p.github_repo_id=c.github_repo_id AND p.enabled=false)
  AND NOT EXISTS (SELECT 1 FROM public.maintainer_invites i WHERE i.github_repo_id=c.github_repo_id AND i.dismissed_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM public.repositories r WHERE r.github_repo_id=c.github_repo_id AND r.archived=true)
  AND NOT EXISTS (SELECT 1 FROM public.markets m WHERE m.github_repo_id=c.github_repo_id AND m.status<>'failed'
    AND NOT (m.status='confirmed' AND m.indexed_at IS NOT NULL AND m.launch_finality IS NOT DISTINCT FROM 'finalized'))
  AND NOT EXISTS (SELECT 1 FROM public.bundles b WHERE b.github_repo_id=c.github_repo_id AND b.status IN ('opening','raising','launching','launched'));

CREATE OR REPLACE VIEW site_public.trend_observations WITH (security_barrier=true) AS
SELECT NULL::integer AS id,o.github_repo_id,o.observed_at,
  jsonb_build_object(
    'repo',jsonb_build_object('id',c.github_repo_id::text,'fullName',c.full_name,
      'language',CASE WHEN jsonb_typeof(j#>'{repo,language}')='string' AND length(j#>>'{repo,language}')<=64 THEN j#>>'{repo,language}' END,
      'avatarUrl',CASE WHEN (j#>>'{repo,avatarUrl}') ~ '^https://avatars\.githubusercontent\.com/[A-Za-z0-9/?=&_.-]+$' THEN j#>>'{repo,avatarUrl}' END,
      'forkOf',CASE WHEN (j#>>'{repo,forkOf}') ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' THEN j#>>'{repo,forkOf}' END),
    'observedAt',o.observed_at,
    'stars',CASE WHEN (j->>'stars') ~ '^[0-9]{1,15}$' THEN (j->>'stars')::bigint END,
    'forks',CASE WHEN (j->>'forks') ~ '^[0-9]{1,15}$' THEN (j->>'forks')::bigint END,
    'releaseAt',CASE WHEN jsonb_typeof(j->'releaseAt')='string' AND (j->>'releaseAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$' THEN j->>'releaseAt' END,
    'activity',jsonb_build_object(
      'complete',coalesce(j#>'{activity,complete}'='true'::jsonb,false),
      'currentCommits',CASE WHEN (j#>>'{activity,currentCommits}') ~ '^[0-9]{1,9}$' THEN (j#>>'{activity,currentCommits}')::integer END,
      'previousCommits',CASE WHEN (j#>>'{activity,previousCommits}') ~ '^[0-9]{1,9}$' THEN (j#>>'{activity,previousCommits}')::integer END,
      'currentContributors',CASE WHEN (j#>>'{activity,currentContributors}') ~ '^[0-9]{1,9}$' THEN (j#>>'{activity,currentContributors}')::integer END,
      'previousContributors',CASE WHEN (j#>>'{activity,previousContributors}') ~ '^[0-9]{1,9}$' THEN (j#>>'{activity,previousContributors}')::integer END)
  )::text AS evidence,NULL::varchar(64) AS evidence_hash
FROM public.trend_observations o JOIN site_public.trend_candidates c ON c.github_repo_id=o.github_repo_id
CROSS JOIN LATERAL (SELECT CASE WHEN o.evidence IS JSON OBJECT THEN o.evidence::jsonb ELSE '{}'::jsonb END AS j) parsed
WHERE o.observed_at >= now()-interval '2 days' AND o.observed_at <= now()+interval '1 minute'
  AND o.evidence IS JSON OBJECT;

CREATE OR REPLACE VIEW site_public.trend_signals WITH (security_barrier=true) AS
SELECT s.id,s.github_repo_id,s.source,
  CASE WHEN s.source='github_trending' THEN 'https://github.com/trending?since=daily'
    WHEN s.source='github_search' THEN 'https://github.com/search?type=repositories'
    ELSE s.url END::text AS url,
  NULL::text AS note,s.occurred_at,s.expires_at,NULL::timestamptz AS detected_at,NULL::text AS operator
FROM public.trend_signals s JOIN site_public.trend_candidates c ON c.github_repo_id=s.github_repo_id
WHERE s.expires_at>now() AND s.occurred_at<=now()+interval '1 minute'
  AND (s.source IN ('github_trending','github_search') OR
    (s.source='hn' AND s.url ~ '^https://news\.ycombinator\.com/item\?id=[0-9]+$'));

CREATE OR REPLACE VIEW site_public.trend_source_health WITH (security_barrier=true) AS
SELECT source,CASE WHEN status IN ('OK','PARTIAL','RUNNING','UNAVAILABLE') THEN status ELSE 'UNAVAILABLE' END::text AS status,
  checked_at,'{}'::text AS detail
FROM public.trend_source_health WHERE source IN ('intake','github_trending','github_search','hn');

RESET ROLE;

-- Fail rather than silently restoring data to a reader that has gained base-table access or write privileges.
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind IN ('r','v','m','p','f') AND (
      has_column_privilege('repoing_operational_public_reader',c.oid,a.attnum,'SELECT,INSERT,UPDATE') OR
      has_table_privilege('repoing_operational_public_reader',c.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES'))
  ) OR EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='site_public' AND c.relname IN ('trend_candidates','trend_observations','trend_signals','trend_source_health')
      AND (NOT has_table_privilege('repoing_operational_public_reader',c.oid,'SELECT') OR
        has_table_privilege('repoing_operational_public_reader',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES'))
  ) THEN RAISE EXCEPTION 'UNSAFE_PUBLIC_DISCOVERY_READER_REQUIRES_OWNER_REVIEW';
  END IF;
END $guard$;
COMMIT;
