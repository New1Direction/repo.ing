-- Repository quality signals (app/lib/repo-quality.mjs): when GitHub created each repository, so market lists, token pages
-- and launch review can tell new repositories (created in the last 30 days, or under 10 stars) from established ones.
-- Nullable: rows fill in as GitHub is next read (launches, repository lookups, and the worker's Dev Pulse check, which reads
-- a repository once without its cached validator while this is unknown). Until then, stars alone decide.
-- IF NOT EXISTS: safe to re-run where an earlier build of this change already added the column.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS github_created_at timestamptz;
