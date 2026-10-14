-- Both fee schedulers read MAX(submitted_at) per market on each pass. Without this index PostgreSQL scans every
-- (wide) short-lived session once per market. MAX ignores nulls, so prepared-but-unsubmitted sessions need no entry.
CREATE INDEX IF NOT EXISTS trade_sessions_repo_submitted ON trade_sessions(github_repo_id, submitted_at) WHERE submitted_at IS NOT NULL;
