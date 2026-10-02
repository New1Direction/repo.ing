# Dev Pulse

[Documentation](README.md) / Dev Pulse

Dev Pulse shows what each live market's repository developers are shipping, from public GitHub activity: a one-line status under the token hero ("Shipping now · 34 commits today · v1.0.0 · 3h ago"), a Dev Pulse card under the chart (commits today and this week, latest release, stars, merged pull requests this week, maintainer status, commits per day for 14 days, and a recent-activity feed), pins on the price chart at the time of each event, and a "Live from GitHub" ticker on the home page.

On market lists, every row (home, Explore, the graduation race) carries a badge: "34 commits today" when the repository shipped in the last 24 hours, "Active this week" within 7 days. Explore has a **Shipping** view ranked by code shipped this week (each commit and merged pull request counts once, a release three; ties go to more developers, then 24h volume), and the home page shows the three community repositories shipping hardest this week ($REPOING and do-not-promote repositories excluded). "Developers this week" counts distinct human authors of commits and merged pull requests (GitHub login, or the git name when unlinked); bots such as Dependabot and Renovate are not counted. The list numbers come from one aggregate (`loadPulseIndex`) cached for 30 seconds per web process.

## Data

The worker (`src/dev-pulse.mjs`, every 2 minutes, at most 12 due repositories per run) reads each live market's repository with the GitHub App installation token. Every read is a conditional request (`If-None-Match`), so an unchanged repository costs nothing against the rate limit:

| Read | When | Stored as |
| --- | --- | --- |
| `GET /repositories/{id}` (rename-safe) | every check (without the validator once, while the repository's creation time is unknown) | `repo_pulse_state` (name, default branch, stars, `pushed_at`), one star snapshot per UTC hour in `repo_pulse_star_hours`, star milestones (10 … 100k); `repositories` stars, forks and `github_created_at` (filled once) for [repository quality signals](PRODUCTION.md#repository-quality-signals-and-official-markets) |
| `GET /repos/{name}/releases` | every check | `release` events (drafts skipped) |
| `GET /repos/{name}/commits?sha={default}&since={14 days}` | when `pushed_at` moved; the first read of a day pages back up to 1,000 commits | `commit` events |
| `GET /repos/{name}/pulls?state=closed` | when `pushed_at` moved | `merge` events (merged pull requests only) |
| Hacker News (public Algolia API) | every 30 minutes | `hn` events for stories linking the repository with at least 10 points |

Busy repositories (pushed within 3 days) are checked every 10 minutes, quiet ones (30 days) every 30 minutes, dormant ones every 3 hours. The collector keeps 800 requests per hour in reserve for the web and pauses until GitHub's reset when the remaining budget drops below that or GitHub answers 403/429. A failing repository is retried after 30 minutes; a missing one after a day.

GitHub no longer lists other repositories' stargazers with timestamps, so "stars today" is the current total minus the hourly snapshot from 24 hours earlier (shown as a lower bound, e.g. `+12+`, while Dev Pulse has watched for less than a day). A star spike is at least 10 new stars, and 0.5% of the total, since the last snapshot from an earlier hour.

Maintainer events are not copied: the read side adds "Maintainer verified on repo.ing" (wallet binding with GitHub admin access) and "Builder claimed X SOL" (settled payouts with their Solscan receipt) from repo.ing's own tables.

Commits that a merged pull request brought in, and GitHub's "Merge pull request" commits, are counted but not repeated in the feed or on the chart.

## Privacy and promotion

Only public repository data is read and shown. Do-not-promote repositories (`PROMOTION_EXCLUDED_REPO_IDS`) are never read, never shown on their token page and never appear in the ticker. Event text from GitHub and Hacker News is rendered as plain text; only `https://github.com/…` and `https://news.ycombinator.com/item?id=…` links are stored.

## Operations

- Tables: migration `0039_dev_pulse.sql` (`repo_pulse_events`, `repo_pulse_state`, `repo_pulse_star_hours`). Commits older than 60 days and star snapshots older than 14 days are pruned hourly.
- Worker env: `GITHUB_APP_PRIVATE_KEY_BASE64`, `GITHUB_APP_INSTALLATION_ID` and `GITHUB_APP_CLIENT_ID` (the web's GitHub App, read-only metadata); `DEV_PULSE_ENABLED=false` turns it off. Without the GitHub App settings the worker logs `{"devPulse":"disabled"}`.
- Each run logs `{"devPulse":{"checked":n,"events":n,"errors":n}}`, or `{"devPulse":{"paused":"…"}}` while waiting for GitHub's rate-limit reset.
- Public API: `GET /api/market/{mint}/pulse` (30 s edge cache); the token page polls it every 2 minutes while visible and passes new events to the chart (`repoing:pulse-updated`).
