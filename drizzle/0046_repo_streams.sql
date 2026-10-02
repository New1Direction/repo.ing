-- Live building streams (src/repo-streams.mjs): a verified repository admin links where the build is streamed (YouTube,
-- Twitch, X or Kick; https only) and can mark it live. "Live" lapses by itself: it holds only while live_until is in the
-- future, and live_until is at most six hours after the change that set it. Token pages link out; nothing is embedded.
-- Idempotent: parallel branches renumbered their migrations, so this may meet a database that already has the table.
CREATE TABLE IF NOT EXISTS repo_streams (
  github_repo_id bigint PRIMARY KEY REFERENCES repositories(github_repo_id),
  url varchar(300) NOT NULL CHECK (url ~ '^https://(youtube\.com|www\.youtube\.com|youtu\.be|twitch\.tv|www\.twitch\.tv|x\.com|kick\.com)/\S+$'),
  live_until timestamptz,
  updated_by_github_user_id bigint NOT NULL CHECK (updated_by_github_user_id > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repo_streams_live_window CHECK (live_until IS NULL OR live_until <= updated_at + interval '6 hours')
);
