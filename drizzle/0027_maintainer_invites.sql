CREATE TABLE maintainer_invites (
  github_repo_id bigint PRIMARY KEY REFERENCES repositories(github_repo_id),
  invited_at timestamptz,
  dismissed_at timestamptz,
  operator_github_user_id bigint NOT NULL,
  operator_login text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maintainer_invites_state_check CHECK (invited_at IS NOT NULL OR dismissed_at IS NOT NULL)
);
