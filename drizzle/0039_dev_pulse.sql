-- Dev Pulse: public GitHub activity for live markets' repositories (commits on the default branch, published releases,
-- merged pull requests, star spikes and milestones, Hacker News stories). The worker collects it with conditional
-- requests; token pages, the price chart and the home ticker read it. Maintainer verification and builder payouts come
-- from repo.ing's own tables at read time and are not copied here.
CREATE TABLE repo_pulse_events (
  id bigserial PRIMARY KEY,
  github_repo_id bigint NOT NULL REFERENCES repositories(github_repo_id),
  kind varchar(16) NOT NULL CHECK (kind IN ('commit', 'release', 'merge', 'stars', 'hn')),
  source_id varchar(128) NOT NULL,
  occurred_at timestamptz NOT NULL,
  title text NOT NULL,
  detail text,
  url text,
  amount integer,
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repo_pulse_events_source UNIQUE (github_repo_id, kind, source_id)
);
--> statement-breakpoint
CREATE INDEX repo_pulse_events_repo_time ON repo_pulse_events(github_repo_id, occurred_at DESC);
--> statement-breakpoint
-- The home ticker reads recent notable events across all markets; commits are aggregated per repository instead.
CREATE INDEX repo_pulse_events_notable_time ON repo_pulse_events(occurred_at DESC) WHERE kind <> 'commit';
--> statement-breakpoint
-- One row per repository: the collector's schedule, conditional-request validators and last observed metadata.
CREATE TABLE repo_pulse_state (
  github_repo_id bigint PRIMARY KEY REFERENCES repositories(github_repo_id),
  full_name text,
  default_branch text,
  stars integer CHECK (stars >= 0),
  pushed_at timestamptz,
  activity_read_for timestamptz,
  etags jsonb NOT NULL DEFAULT '{}'::jsonb,
  hn_checked_at timestamptz,
  checked_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  error text
);
--> statement-breakpoint
-- The repository's star total as last observed in each UTC hour. GitHub no longer lists other repositories' stargazers,
-- so "+48 stars today" and star spikes are differences between these snapshots.
CREATE TABLE repo_pulse_star_hours (
  github_repo_id bigint NOT NULL REFERENCES repositories(github_repo_id),
  hour timestamptz NOT NULL,
  stars_total integer NOT NULL CHECK (stars_total >= 0),
  PRIMARY KEY (github_repo_id, hour)
);
