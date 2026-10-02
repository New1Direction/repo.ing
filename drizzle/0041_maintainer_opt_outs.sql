-- Maintainer decisions (see src/maintainer-opt-outs.mjs): a current GitHub admin of a repository declines its market
-- ('decline') or, for a repository without one, opts it out of repo.ing ('opt_out'). While a decision is active
-- (withdrawn_at IS NULL) repo.ing never promotes the repository, its token page says the maintainer declined, and no new
-- market can be launched for it. An existing market keeps trading so holders can exit, and its builder fees stay
-- claimable by the verified maintainer. Withdrawing restores normal behavior; withdrawn rows stay as history.
-- Keyed by GitHub repository ID without a foreign key: a repository that was never launched may have no repositories row.
CREATE TABLE maintainer_opt_outs (
  id bigserial PRIMARY KEY,
  github_repo_id bigint NOT NULL CHECK (github_repo_id > 0),
  kind varchar(16) NOT NULL CHECK (kind IN ('decline', 'opt_out')),
  github_user_id bigint NOT NULL CHECK (github_user_id > 0),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 280),
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  withdrawn_by_github_user_id bigint CHECK (withdrawn_by_github_user_id > 0),
  CONSTRAINT maintainer_opt_outs_withdrawn_check CHECK ((withdrawn_at IS NULL) = (withdrawn_by_github_user_id IS NULL)
    AND (withdrawn_at IS NULL OR withdrawn_at >= created_at))
);
--> statement-breakpoint
-- At most one active decision per repository. Also serves every read: one repository's decision (token page, launches)
-- and the whole active set (promotion surfaces).
CREATE UNIQUE INDEX maintainer_opt_outs_one_active ON maintainer_opt_outs(github_repo_id) WHERE withdrawn_at IS NULL;
