-- Read paths behind public pages, market APIs and the worker's per-market passes. Production pg_stat_user_tables
-- (2026-10-01) showed these small tables sequentially scanned hundreds of thousands to millions of times with zero index
-- scans. They are small, so plain CREATE INDEX inside the migration transaction is fine (no CONCURRENTLY).
--
-- trade_events: the latest price per pool (listMarkets' DISTINCT ON and the single-market LATERAL, both ordered by
-- slot DESC, event_index DESC), the activity feed and chart history by pool, and the 24 h volume per pool.
CREATE INDEX trade_events_pool_slot ON trade_events(pool, slot DESC, event_index DESC);
--> statement-breakpoint
CREATE INDEX trade_events_pool_time ON trade_events(pool, traded_at);
--> statement-breakpoint
-- damm_trade_events: the latest graduated price (DISTINCT ON / LATERAL by repository), lifetime volume per repository
-- (index-only with quote_amount included) and the graduated chart leg (repository + slot range).
CREATE INDEX damm_trade_events_repo_slot ON damm_trade_events(github_repo_id, slot DESC, event_index DESC) INCLUDE (quote_amount);
--> statement-breakpoint
-- Builder credits: the builder_fee_credits view sums fee_events and damm_fee_events per repository (token page, claim,
-- reconcile, builders, badge, growth); the activity feed lists a repository's fee rows newest first.
CREATE INDEX fee_events_repo_slot ON fee_events(github_repo_id, slot DESC, event_index DESC) INCLUDE (amount_base_units);
--> statement-breakpoint
-- The external fee indexer's per-market "credited but not charted" check (WHERE pool = $1 ... ORDER BY signature).
CREATE INDEX fee_events_pool_signature ON fee_events(pool, signature);
--> statement-breakpoint
CREATE INDEX damm_fee_events_repo ON damm_fee_events(github_repo_id) INCLUDE (amount_base_units);
--> statement-breakpoint
CREATE INDEX platform_fee_events_repo ON platform_fee_events(github_repo_id) INCLUDE (amount_base_units);
--> statement-breakpoint
-- Open alerts of one kind for one market (the fee indexer's quarantine review, every pass and market), and alerts by kind
-- (reserve-alert delivery).
CREATE INDEX graduation_alerts_open_repo_kind ON graduation_alerts(github_repo_id, kind, id) WHERE acknowledged_at IS NULL;
--> statement-breakpoint
CREATE INDEX graduation_alerts_kind ON graduation_alerts(kind, id);
--> statement-breakpoint
-- Where each indexed trade's transaction sits in its finalized block. finalized_chart_blocks keeps the block's complete
-- signature list (~1-2K signatures, ~100 KB per row, ~170 MB in all) as the agreed evidence; chart reads and the ordering
-- worker used array_position() over it, de-TOASTing a whole block for every trade on every request. This table keeps
-- just the trade signatures' positions (derived from the immutable block, so it never changes); readers fall back to the
-- block list only for a trade indexed after its block was recorded, until the ordering worker fills that position in.
CREATE TABLE finalized_chart_positions (
  slot bigint NOT NULL REFERENCES finalized_chart_blocks(slot),
  signature varchar(88) NOT NULL,
  transaction_index integer NOT NULL CHECK (transaction_index > 0),
  PRIMARY KEY (slot, signature)
);
--> statement-breakpoint
INSERT INTO finalized_chart_positions(slot, signature, transaction_index)
WITH positions AS MATERIALIZED (
  SELECT t.slot, t.signature, array_position(b.signatures, t.signature::text) AS transaction_index
  FROM (SELECT slot, signature FROM trade_events UNION SELECT slot, signature FROM damm_trade_events) t
  JOIN finalized_chart_blocks b ON b.slot = t.slot
)
SELECT slot, signature, transaction_index FROM positions WHERE transaction_index IS NOT NULL;
--> statement-breakpoint
-- Real-user Core Web Vitals (POST /api/vitals, ~25% of page views): no cookies, IPs, wallets or URLs, only the route
-- pattern (e.g. /token/[mint]), the metric, its value (ms; CLS unitless), the standard rating and a mobile/desktop
-- class from a User-Agent heuristic. Rows older than 14 days are deleted by the web service.
CREATE TABLE web_vitals (
  id bigserial PRIMARY KEY,
  route varchar(64) NOT NULL,
  metric varchar(4) NOT NULL CHECK (metric IN ('LCP', 'INP', 'CLS', 'FCP', 'TTFB')),
  value double precision NOT NULL CHECK (value >= 0 AND value <= 600000),
  rating varchar(17) NOT NULL CHECK (rating IN ('good', 'needs-improvement', 'poor')),
  device varchar(7) NOT NULL CHECK (device IN ('mobile', 'desktop')),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX web_vitals_created_at ON web_vitals(created_at);
