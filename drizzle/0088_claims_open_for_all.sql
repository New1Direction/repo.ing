-- Expand-only. Claims open for every repository at once (owner, 2026-10-26), except the closed list (src/builder-payouts.mjs).
SET LOCAL lock_timeout = '5s';
-- When set, claims are open for every repository without its own repo_claim_windows row; it starts their 12-month
-- unclaimed window. Null keeps the per-repository opening.
ALTER TABLE claim_controls ADD COLUMN IF NOT EXISTS opened_for_all_at timestamptz;
--> statement-breakpoint
-- Repositories whose claims stay closed until the owner removes them here: never swept (1250276806, 1332056763) and not
-- yet covered by the vault (1388219884 repo.ing, 1391948723 jumper).
CREATE TABLE IF NOT EXISTS claim_closed_repos (
  github_repo_id bigint PRIMARY KEY,
  reason text NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO claim_closed_repos (github_repo_id, reason) VALUES
  (1250276806, 'paused and never swept (owner, 2026-10-25)'),
  (1332056763, 'paused and never swept (owner, 2026-10-25)'),
  (1388219884, 'owed fees not yet covered by the vault (owner, 2026-10-26)'),
  (1391948723, 'owed fees not yet covered by the vault (owner, 2026-10-26)')
ON CONFLICT (github_repo_id) DO NOTHING;
