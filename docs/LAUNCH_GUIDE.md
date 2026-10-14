# Guided launch and launch preflight

[Documentation](README.md) / Guided launch

Release 2026-10-14 (migration `0073_launch_guide`). `/launches/new` walks a maintainer from GitHub sign-in to a published, public launch schedule, with a factual preflight before anything is committed. It builds on [launch transparency](LAUNCH_TRANSPARENCY.md) and changes none of it: the score is the [Launch Quality](LAUNCH_TRANSPARENCY.md#launch-quality-score) criteria and points, publishing writes the same [scheduled launch](LAUNCH_TRANSPARENCY.md#scheduled-launches-and-the-launch-calendar) as `/launches/manage`, and the coordinator's launch gate, the 3% initial-buy cap and the claim flow are untouched.

Ground rules, the same as the public report:

- **The preflight is free and comes first.** Anyone can run it on any public GitHub repository without signing in, connecting a wallet or paying (`/launches/new`, `GET /api/launch-preflight`, read-only MCP `launch_preflight`).
- **Facts, not a rating.** Each criterion names its source and the time it was read. Unknown is unknown, never a pass or a zero.
- **Never pay-to-rank.** The preflight's inputs are a fixed list (`PREFLIGHT_INPUTS` in `src/launch-preflight.mjs`). Fees, tips, credits, promotion, raises, price, market cap and volume cannot change a criterion or a requirement (tested). Lists stay ordered by time.
- **Nothing is public before Publish.** Drafts are private to the GitHub account that made them; the preview is a picture of the public page.

## The flow

```diagram
┌──────────┐  ┌────────────┐  ┌───────────┐  ┌──────┐  ┌──────────┐  ┌─────────┐  ┌─────────┐
│ GitHub   │─▶│ Repository │─▶│ Preflight │─▶│ Plan │─▶│ Disclose │─▶│ Preview │─▶│ Publish │
└──────────┘  └────────────┘  └───────────┘  └──────┘  └──────────┘  └─────────┘  └─────────┘
 identity      fresh admin     requirements    time,     seeded         the public   admin checked
 sign-in       check; draft    + pre-launch    wallet,   positions,     launch page  again; writes
 (read-only)   created         quality score   buy, note lock states,   and calendar launch_schedules
                                                          controls       entry
```

| Step | What happens | Reads |
| --- | --- | --- |
| GitHub | Identity sign-in (`/api/github/start?mode=launch-guide`, read-only GitHub App). The same session as `/launches/manage`, one hour. Without signing in, the step offers the public preflight for any repository. | — |
| Repository | The public repositories the account administers that the App can see, with each one's market, opt-out and schedule. Selecting one checks admin access with GitHub again and opens (or resumes) the draft. A non-admin is told which access GitHub reports; a repository the App cannot see links to GitHub App access. | GitHub (1 per 100 repositories; 3 to select) |
| Preflight | The requirements and the pre-launch Launch Quality score (below). "Run again" re-reads GitHub. A blocked repository stops here. | See [cost](#cost-per-preflight) |
| Plan | Launch time (at least 1 hour, at most 30 days ahead), window (15 minutes to 24 hours), launching wallet (typed or the connected wallet), initial buy (none, 1%, 2% or 3% of supply, priced from the current config), optional ticker (checked, not reserved) and public note. "Save and check" saves and re-runs the plan requirements. | The wallet's balance (1 RPC read) |
| Disclose | What is seeded at launch and its lock state, and the launch controls the system enforces. Publishing needs the acknowledgement. | — |
| Preview | The repository's launch page and calendar entry as they will look, rendered by the same components (inert). | — |
| Publish | Re-checks the plan and admin access, then creates the schedule: public at once on `/launches`, the feeds and webhooks. Idempotent. Then links to the listing, the launch page, the calendar file and Manage. | GitHub (3), database |

Launching itself is unchanged: during the window the maintainer opens `/launch/<repo>` from the announced wallet and approves the transaction in their wallet. The guide never signs or holds anything.

## Preflight

`src/launch-preflight.mjs` is pure: facts in, a report out. `src/launch-guide.mjs` reads the facts.

### Requirements

Each requirement has a status (`met`, `warn`, `missing`, `blocked`, `unknown`), what was checked, its evidence where there is one, the steps it is required for (`schedule`, `launch`, or none for advisory items) and, unless met, what to do: text, a link and/or an action (`retry`, `plan`).

| Requirement | Blocks | When not met |
| --- | --- | --- |
| Public GitHub repository | everyone | Private or missing: make it public. Archived: unarchive. GitHub unreadable: unknown, retry. |
| One market per project (fork guard) | everyone | A fork or copy of a launched repository ([fork guard](FORK_GUARD.md)), with a link to the original's market. A first commit GitHub cannot list now is a caution; launch prepare checks again. |
| Current GitHub admin | schedule | Signed out: sign in. Not an admin: the access GitHub reports, ask an admin or switch accounts. App cannot see it: give the App access. |
| No market or launch in progress | everyone | A market: link to it (and its claim page). A launch in progress: retry in minutes. |
| Maintainers have not opted out | everyone | Withdraw the opt-out at `/opt-out` (admins only). |
| No Group launch raise open | everyone | Link to the raise. |
| Not already scheduled | this plan | Who scheduled it and when; manage or cancel it. A lapsed window no longer counts. |
| Launches / scheduling open | everyone / schedule | Paused by repo.ing; retry later. |
| Launch time, launching wallet, initial buy, note | schedule | The exact rule broken (notice, window, address, blocked wallet, a buy above the 1 SOL a schedule may announce, an unpriced buy). |
| Launching wallet can pay | advisory | The shortfall (initial buy plus about 0.025 SOL of launch accounts and fees, rounded up). Not needed to publish; the launch review simulates the exact cost. |
| Ticker | launch | Invalid or used by another market. Tickers are not reserved. |

The verdict is `blocked` when the repository cannot launch for anyone, `ready` when every requirement for a schedule is met, and `needs-action` otherwise.

### Launch Quality before launch

The preflight runs `launchQualityReport` with the facts that exist before a market does, and labels every criterion with its basis:

- **From GitHub and repo.ing:** repository age, stars, commits in the last 7 days (read by the preflight itself, one GitHub request), fork status, and the maintainer (a current admin counts as verified for the preflight; the public report shows "Verified" once an admin verifies on the market's claim page after launch).
- **From your plan:** the initial buy (as a share of supply) and the announcement.
- **From the launch config:** the launch fee window and the locked liquidity at graduation.
- **After launch:** mint and freeze authorities, holder concentration, the launcher's indexed holding, organic volume and executable depth. These are unknown before launch, listed with what will measure them, and left out of the pre-launch score.

The pre-launch score is the public report's formula (points over known maximum) over the pre-launch criteria only, shown with its coverage, and not shown below 60% coverage. Signed out with no plan, a repository with complete GitHub facts is at 67% coverage; without GitHub's creation date it is at 50% and has no score. The public report starts with the after-launch criteria unknown, so its score can differ; the page says so.

### Seeded liquidity and controls

The disclosure uses the public report's lock words (`src/seeded-liquidity.mjs`), as planned: the launcher's initial buy (unlocked, no vesting), the 1% builder allocation where the config has one (claimable after graduation), the bonding-curve reserve (program-held), the liquidity at graduation (permanently locked), and no repo.ing or team liquidity. The controls are those the current system enforces for a scheduled launch: the public announcement, nobody launching early, only the announced wallet in the window, the announced buy cap, no Group launch or early access in the window, the launch fee window, the window lapsing, and cancelling.

The initial buy is announced in lamports as the config's exact preset for the chosen share (`launchBuyPreset`, the largest buy whose tokens stay within it). The launch page computes the same preset from the same config, so a 3% launch passes the scheduled-launch gate exactly (validator-tested). If repo.ing changes its launch config before the window, a preset may price differently; launch with a custom amount no larger than the announced one.

## Drafts: save and resume

`launch_guide_drafts` (migration `0073`) holds a maintainer's plan: one open draft per GitHub account (numeric id) and repository, the step reached, the plan (time, window, wallet, initial-buy share, note, optional name and ticker, acknowledgement; at most 4 KB), the last preflight and when GitHub last confirmed admin access. Every read and write is scoped to the signed-in account. The browser keeps only the open draft's id (localStorage), so a GitHub sign-in round trip or a closed tab returns to it; `/launches/new?draft=<id>` resumes it on any device signed in to the same account. Drafts are deleted 30 days after their last change or their publication; the schedule is the public record.

## Failure and retry

Every request has a 45-second limit. Each failure shows what happened and a "Try again" button that repeats exactly that request; nothing is lost because the draft is on the server. An ended GitHub session (one hour) shows "Sign in with GitHub again" and resumes the draft afterwards. GitHub hiccups are `unknown` with a retry, never a pass. A refused publish returns the preflight that refused it, so the page shows what is missing. Publishing twice, or after a response was lost, returns the same schedule (the draft adopts a schedule with its own account, wallet and time) and never creates a second one.

## Accessibility

An ordered list of steps with `aria-current="step"`; focus moves to the new step's heading; statuses are words, not only colors; errors use `role="alert"` and progress `role="status"`; form fields have labels and hints (`aria-describedby`) and mark invalid values (`aria-invalid`); the initial buy is a radio group with a legend; the preview is `inert`; the layout works at 390 px wide; no motion.

## Measurement

`launch_guide_events` stores conversion events with an event, a step, a source and an outcome from fixed lists (database constraints) and a public repository id. No GitHub login or id, wallet, cookie, URL, query or IP. A browser sending Global Privacy Control or Do Not Track sends no beacon, and the server records nothing for such a request. Events are deleted after 180 days. Recording never changes a response.

| Event | Recorded by | Outcome |
| --- | --- | --- |
| `guide_view`, `step_view` (with `step`) | Browser beacon (`POST /api/launch-guide/events`, strict shape, rate-limited) | — |
| `github_connect`, `github_result` | `/api/github/start`, `/api/github/callback` (`mode=launch-guide`) | verified, cancelled, failed |
| `repo_selected`, `draft_resumed` | Selecting a repository | admin, not-admin, no-access, failed |
| `preflight_run` | The public preflight and the guide | ready, needs-action, blocked, unavailable |
| `publish` | Publishing | scheduled, refused, failed |
| `draft_discarded` | Discarding a draft | — |

Attribution: `?src=` on links into `/launches/new` (`launch`, `repo`, `calendar`, `manage`, `builders`, `claim`, `opt-out`, `agents`, `cli`, `docs`, `x`; `app/lib/launch-guide-funnel.mjs`), carried through GitHub sign-in in the sealed OAuth state. Entry points: the launch page, each repository's launch page, the launch calendar and Schedule a launch, and the MCP tool's guide link. `/operations/funnel` (operators) shows the events for 24 hours, 7 and 30 days, views per step, and views → published by source.

## Cost per preflight

Measured locally (development server, real GitHub API) with `profile` on each response:

| Run | GitHub requests | Database queries | RPC requests |
| --- | ---: | ---: | ---: |
| First preflight of a repository | 4 (repository, last week's commits, first commit for the fork guard: 2) | 5 (2 state, 3 fork guard) | 0 |
| Again within 10 minutes, any visitor of the same web process | 0 | 2 | 0 |
| With a full plan | +0 | +0 | 1 (the wallet's balance) |
| Launch config | — | — | 1 per process, ever (the config cannot change) |

- GitHub facts are cached per repository for 10 minutes per web process (500 repositories at most); a GitHub failure is never cached. Saving, resuming and "Save and check" read no GitHub. The admin check (3 requests) runs at selection and at publish and is reused for 15 minutes in between.
- repo.ing's own state (market, opt-out, Group launch, ticker, schedule) is always read fresh, in two queries.
- The config account is read once per process and shared with the launch fee copy (`configState` in `app/lib/launch-fee.mjs`); the initial-buy presets are local math on it.
- Anonymous preflights (the public route and MCP) share a budget of 150 uncached repositories an hour across all replicas (`launch-preflight:github` in `agent_request_limits`, at most about 600 GitHub requests, an eighth of the App's hourly allowance); a cached repository is always answered, and a spent budget answers 429 with Retry-After. `GET /api/launch-preflight` also allows a burst of 20 and 6 a minute per address (`launch:preflight`); the guide's actions allow 240 changes and 20 publishes an hour per GitHub account.

## API

- `GET /api/launch-preflight?repo=<id | owner/name | github.com URL>&src=<source>`: `{ preflight, profile, repository }`; 400 for an unreadable input, 404 when GitHub does not serve it publicly. Public, no key.
- `GET /api/launch-guide[?repositories=1]`: `{ signedIn, githubLogin, drafts, repositories }` for the session.
- `POST /api/launch-guide` (same origin, GitHub session): `{ action: 'select', repoId }`, `{ action: 'save', draftId, step?, plan? }`, `{ action: 'check', draftId, plan?, refresh? }`, `{ action: 'publish', draftId }`, `{ action: 'discard', draftId }`. Errors are `{ error, code }` with `PLAN_INCOMPLETE`, `NOT_ACKNOWLEDGED`, `PREFLIGHT_NOT_READY` (with `detail.preflight`), the schedule's own codes, or `SIGN_IN` (401).
- Read-only MCP `launch_preflight` (`/api/mcp/readonly`): the verdict, pre-launch score and coverage, each open requirement with what to do, the unknowns and the guide link.

## Deploying

Migration `0073_launch_guide` is additive (two new tables, indexes; nothing existing changes) and runs in web's pre-deploy `npm run db:migrate`. Only the web service changed; the worker does not read the new tables, so it needs no redeploy. No new settings: the guide follows `LAUNCH_SCHEDULES_ENABLED` and the launch availability the launch page uses. Before the migration, `/launches/new` still renders and the public preflight works; drafts and publishing answer "unavailable", and events fail quietly.

After deploy:

```sh
curl -s 'https://repo.ing/api/launch-preflight?repo=new1direction/repo.ing' | jq '{verdict: .preflight.verdict, score: .preflight.quality.score, coverage: .preflight.quality.coveragePercent, profile}'
psql "$DATABASE_URL" -c "select event, outcome, count(*) from launch_guide_events where created_at > now() - interval '1 day' group by 1, 2 order by 1, 2"
```

## Verification

- Quick (`tests/launch-guide.test.mjs`): requirements and remediation for every blocker and plan rule; the pre-launch score from hand-derived points; the coverage boundary; never pay-to-rank; seeding and controls; plan normalization; repository input; GitHub reads (private, archived, renamed, empty, unavailable); the service's request counts and caching; events, Global Privacy Control and Do Not Track; the migration; the MCP tool.
- PostgreSQL (`tests/launch-guide-db.test.mjs`, `LAUNCH_GUIDE_TEST_DATABASE_URL` at `repoing_launch_guide_test`): migration re-run; drafts owned per account, resumed, size-limited and pruned; events limited to fixed values with no column that can hold a person; select, check and publish end to end with exactly one schedule; refusals when a market or schedule appears; adopting a lost publish; repo.ing's state in two queries.
- Validator (`tests/launch-guide-chain.test.mjs`, `DATABASE_URL` at `repoing_launch_guide_chain_test`): the launch terms of a real launch-fee config (each preset the largest buy within its share), the wallet's balance from the chain, the published 3% buy, and the coordinator refusing a launch before the time, another wallet and one lamport more, then launching exactly the planned buy (at least 2.99% and at most 3% of supply).
