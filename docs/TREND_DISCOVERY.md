# P6 — Trend Detection + Discoverer Growth

Scope approved September 26, 2026. This extends repository discovery and the existing explicit launch path. It introduces no fee policy, reward ledger, trading agent, or spending authority.

## Sources and cadence

`src/trend-sources.mjs` reads public endpoints without credentials:

| Source | Evidence | Limits |
| --- | --- | --- |
| GitHub repository REST API | Immutable ID and current owner/name, stars, forks; compare ID and named endpoint | Invalid/private/archived/disabled repositories rejected; redirects are not trusted |
| GitHub latest release | Published release time and release URL | Missing release earns zero points |
| GitHub default-branch commits | Last 24 hours versus preceding 24 hours; identified GitHub authors | One 100-commit page over 48 hours; a next-page link makes activity unavailable rather than estimating it |
| GitHub Trending | Presence on the daily page; source URL and detection time | Optional HTML source; parser failure is visible and contributes no new evidence |
| GitHub Search | Top ten by stars, ≥20 stars, created within 90 days, pushed within 7 days, not a fork/archive | Seeds only, no score for total stars or search position; incomplete responses rejected |
| Hacker News / Algolia | Up to 100 recent stories linking directly to GitHub, within seven days; exact story IDs/links | Observed story count, not an exhaustive claim about all HN discussion; deduplicated by story URL |
| Curated CT / narrative | Operator-supplied HTTPS X/Twitter/HN/GitHub link, time, note, actor | Seven-day expiry; no points; operator assertion is labeled separately from automated evidence |

Worker flag: `TREND_INTAKE_ENABLED=true`. A background pass runs at most once per 30 minutes across worker restarts/replicas, protected by a Postgres advisory lock and durable attempt timestamp. One search and at most five four-request repo observations cost at most 42 GitHub API requests/hour in the scheduled collector. Requests are sequential, at least one second apart, and stop at the API reserve/rate-limit boundary. Retry-after/reset headers are honored within a pass; the durable half-hour cadence prevents restart storms. Manual submissions also consume public API quota and can be rate-limited independently.

The watch cohort is the most recent 32 non-rejected/non-duplicate candidates, with approved candidates preferred; four are refreshed oldest-attempt-first and one new source repo admitted per pass (five new repos on an empty queue). Without a new repo, five existing candidates refresh. Older records remain durable and become visibly stale; they are not silently scored as fresh. Reviewed/approved candidates can always be refreshed through a new curated observation. Public observations expire after six hours. External mention evidence has its own expiry; no source failure fabricates attention or velocity.

Primary references: [GitHub repository search](https://docs.github.com/en/rest/search/search#search-repositories), [REST API practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api), [HN search API](https://hn.algolia.com/api), [GitHub Trending](https://github.com/trending).

## Transparent score v1 (0–100)

| Input | Points |
| --- | --- |
| Positive star velocity, normalized to 24 hours | `min(25, floor(stars per day / 10))` |
| Star acceleration | 10 when latest interval added ≥10 stars and its rate is ≥2× the previous interval rate, with a 1/day floor |
| Positive fork velocity, normalized to 24 hours | `min(15, floor(forks per day))` |
| Identified contributor acceleration | 2 per additional unique GitHub author in the current versus preceding 24h; max 10 |
| Commit acceleration | 5 when current 24h has ≥5 commits and ≥2× preceding 24h count, with a one-commit floor |
| Release published within seven days | 10 |
| Observed HN stories within seven days | 5 per distinct story, max 15 |
| Current GitHub Trending presence | 10 |
| Manual narrative | 0 |

Star/fork rates need two real snapshots separated by 1–48 hours; acceleration needs three. Unknown or incomplete inputs earn zero and show why. Negative deltas remain visible and earn zero. Ties sort by immutable repo ID. The score is a discovery sorting aid, not a quality endorsement, price forecast, or trade recommendation.

## State and evidence

`detected → reviewed → approved → launched → active`

- Operator-only review transitions are audited in `trend_reviews`, with the exact observation, score inputs, source links and actor. Revision checks reject stale tabs.
- Rejection is explicit. Rejected/duplicate candidates can return to review only when identity, freshness and market uniqueness permit it.
- Approval captures the active DBC config, immutable discovery policy version, 30-day window and time. Approval revocation also works while a wallet review is open.
- `launched` requires the existing finalized canonical launch indexer and a matching `trend_launches` preparation record. `active` additionally requires an actual recorded trade. Signals never create either condition.
- A market launched through another path is identified as an existing/duplicate market, never retroactively credited to this workflow.
- Candidates use GitHub's immutable repository ID. `trend_observations` keeps timestamped evidence and SHA-256 hashes. Signals deduplicate by ID/source/URL. Review snapshots retain the exact inputs at approval, even when later observations change.
- `trend_launches` records preparation provenance (mint, repo, approved config/revision, wallet, evidence); it is not a market or financial ledger. Failed/cancelled preparations remain distinguishable by their absence from canonical indexed markets.

## Discoverer attribution and leaderboard

Attribution remains in `markets`: immutable GitHub ID, finalized launch signer, mint, pool, signature/slot, discovery version, and DBC activation timestamp. Existing launch verification checks the actual transaction's required signer and canonical DBC instruction. Migration 0017 adds a database trigger preventing reassignment, policy changes, receipt changes, timestamp changes or de-indexing once indexed. An initially absent legacy timestamp may be filled once by the existing verifier.

`/discoverers` aggregates **existing** `discovery_fee_events`, `discovery_claims`, `trade_events`, and durable `graduation_events`. Fees earned include settled payouts; they do not fall to zero after claiming. Version 1 keeps its 1 SOL cap; version 2 keeps 2.5 SOL. No historical unenrolled market is awarded rewards.

Reward-period volume counts matching finalized reward-eligible DBC trade evidence, from inclusive verified activation to the exclusive 30-day end, stopping when the cap is reached (including its crossing trade). DAMM trades do not enter the reward total. If the cap crosses among multiple transactions in one slot and the existing tables cannot establish their ordering, volume is shown as requiring verification rather than inventing an order. Missing matching trade evidence, wrong pool, invalid period, wrong claim recipient or overpayment excludes that market and exposes an operator error. The public page discloses partial results. Legacy unenrolled launches count as launches, with zero reward earnings and reward-period volume.

Leaderboard sorts by earned discovery fees, then eligible market volume, then launches and wallet address. It shows copyable wallet, fees, reward-period market volume, launches and verified graduations. Expand a wallet to see source repositories, launch receipts, launch time, policy window, cap, earned and paid. Volume describes the market, not trades made by the discoverer. No points, badges or new incentive mechanics.

## Operator and public surfaces

- `/operations/trends`: configured immutable-ID GitHub operator allowlist; source health, decomposed score, current identity, freshness, indexed/market state, review actions, curated links and recent trend launches. Uses the existing encrypted builder session with separate operator authorization. POST requires same-origin. There are no launch-signing or spending controls in this endpoint.
- Public `/explore`: New Markets, Closest to Graduation, Top Builder Earners, Top Discoverers, plus existing market filters/watchlist. The **Markets | Find repos** navigation puts Trending Repos on its own `/find-repos` page, keeping live-market browsing separate from repository discovery. Only fresh verified trend data is public. Existing markets link to their market; approved new candidates link to review/launch; other fresh candidates link to GitHub. Rejected candidates and private operator notes are not public.
- Explore's visible tab refreshes the curated `/api/growth` projection once a minute. Graduation uses P5's exact verified state and expires at its original validity boundary. Stale progress is never held as a current estimate. Builder earnings are lifetime credited fees. New/recent market volume includes indexed DBC plus DAMM trades.
- Public data never contains operator actions, actor IDs, internal approval evidence, financial intents or signing material. Routes use no-store responses.

## Exact detection → live workflow

1. Worker detects a public source link, resolves GitHub ID and named endpoint, records timestamped observation and source evidence.
2. Operator visits `/operations/trends`, inspects “Why this repository?”, source links, change interval and launch readiness.
3. Click **Mark reviewed**, then **Approve launch**. Server rechecks GitHub identity, freshness, canonical market absence, active config and current reward enrollment.
4. Click **Review & launch**. Existing `/launch/<GitHub ID>?from=trend` shows the repo and normal launch form. The wallet user explicitly chooses name/ticker/optional first buy, reviews costs and signs. Any connected wallet may be the discoverer of an operator-approved candidate; holding a GitHub operator session does not confer wallet control.
5. Existing launch coordinator serializes by repository. A trend guard runs before requesting the wallet signature and again before submitting: exact repo/revision, freshness, active config, enrolled reward version/window and launch wallet must still agree. Concurrent launches retain the existing canonical uniqueness lock.
6. Existing indexer verifies the finalized launch. Market becomes live; existing success screen links to it. The trend worker links the prepared mint to its indexed canonical receipt and records `launched`; the first genuine indexed trade changes it to `active`.
7. Existing worker accrues actual discovery fees. Leaderboard and public surfaces update from that same ledger. Reward claiming uses the existing signed claim flow.

No candidate is automatically approved, launched, traded, funded, or sent to social accounts.

## Failure matrix

| Condition | Result |
| --- | --- |
| GitHub unavailable / rate-limited / private / archived / invalid ID | No new verified observation; prior candidate marked unavailable or expires; launch shortcut blocked |
| Named and immutable identity disagree / source ID differs | Observation/approval/launch rejected |
| Rename/transfer/alias | Refresh by immutable ID; named lookup must agree; existing market key is unchanged |
| Existing market, including pending/ambiguous launch | No second canonical launch; existing confirmed market linked or pending review shown |
| Stale observation (>6h) | Approval/launch guard rejects; public feed removes it |
| Trending markup changes / HN or search failure | Source status visible; no invented evidence; other sources continue |
| Incomplete GitHub search / truncated commit window | Search rejected / activity points unavailable |
| Stale review revision, revoked approval | Reload/review required; submission rejected even after wallet review |
| Wrong config / reward version / 30-day window | Preparation and submission fail closed |
| Missing or mismatched discoverer / prepared mint | No trend launch attribution; operator review required |
| Invalid ledger period / wrong pool / wrong claim wallet / overpaid rewards | Exclude attribution from public totals, show operator error; no ledger edits |
| Missing trade proof / ambiguous cap-crossing ordering | No invented volume; attribution excluded or volume unavailable |
| Worker restart / duplicate source or launch event | Advisory lock, cadence timestamp, unique observations/signals and transition guards prevent duplication |
| Stale/mismatched graduation | P5's public projection rejects progress; P3/P4 gates unaffected |

## Verification and deployment

Focused checks cover score decomposition, real elapsed intervals, source validation, stale data, manual source restrictions, incomplete commit windows, policy caps/periods, attribution and cross-repo failures. The disposable Postgres integration rehearses intake → reviewed → approved → explicit launch adapter → finalized indexing → active; revocation during wallet review prevents submission; duplicate requests do not launch twice; the immutable attribution trigger rejects reassignment. This is a local adapter rehearsal of the reused launcher, not a new mainnet launch receipt.

The migration upgrade check verifies monotonically increasing journal timestamps and idempotent upgrades from the deployed P3 schema through P6, preserving existing rows. The original financial launch path and discovery policy tests remain unchanged.

Apply additive migration 0017 with web predeploy before starting the new worker. Enable only `TREND_INTAKE_ENABLED` on the worker; it requires no new secret. Keep P3/P4/buybacks explicitly false. Turning intake off preserves all queue/review/provenance data and does not affect existing reward claims or trading indexes. On rollback retain migration 0017 and its immutable attribution protection.

Production rollout evidence is appended after readback. The next action after P6 is operator curation and organic distribution; no further economic subsystem is started here.


## Production rollout — September 26, 2026

- Deployed code: `5184120`, saved to private `New1Direction/repoing`, branch `codex/trend-discovery`.
- Final web deployment `5797a0ab-d460-4c1d-8442-12a824dbf1a5` and worker `859f27e3-21ac-4c3b-9b02-2b8874b1c5ef` both succeeded. Container readback confirmed both final IDs.
- Migration 0017 applied: 18 total migrations, all P6 tables present, immutable indexed-attribution trigger present. Existing market data preserved.
- Worker intake enabled; P3, P4 and buybacks explicitly `false` on both services. Operator allowlist configured. No P6 operator approvals, trend launch preparations, test markets, P3 intents or P4 intents were introduced.
- Checkpoint `2026-09-26T23:51:27.340Z`: **19 indexed markets** among 20 market rows, zero graduations, zero claimed platform revenue and zero liquidity reserve. The one previously unavailable/unindexed launch remains outside indexed-market totals.
- Platform revenue and liquidity reconciliation: **MATCH**. New real launches/trades arrived during rollout. A new gods-eye-view pool briefly lagged by exactly 5,509 lamports of builder fees; canonical signature `37C6wEKqUDYrn7nBux2EPynRF7dcWDRFaE6c1dP7e8RFUJzRYqZyAHX3977Cz39QJgXfTpP3vy3vsuhuqHbWNhqw`, slot `450826902`, supplied that credit through normal indexing. A fresh RPC read matched 22,428,710 recorded and on-chain lamports, difference zero. Another actively traded pool had a transient observation lag in the later snapshot; the closing read at `2026-09-26T23:52:46.753Z` found no remaining non-MATCH stored reconciliations. Alerts were retained and no balance was edited to hide a difference.
- First collector pass: GitHub Trending 15 links, HN 96 qualifying observed stories, GitHub Search 10 seeds; five repositories verified, all source checks OK. Its completion timestamp was `2026-09-26T23:45:01.953Z`. The final worker restart returned `WAITING` at `23:47:38Z`, demonstrating durable cadence without immediately replaying source requests. Fee cycles continued with 19 `OK` results and no fee recovery errors.
- First five candidates are below. Their velocity/acceleration inputs are **warming up**: no invented historical star/fork changes. These scores currently use release, HN and Trending presence.

| Repository | GitHub ID | Score | State |
| --- | --- | --- | --- |
| [dream-num/univer](https://github.com/dream-num/univer) | 543101941 | 25/100 | detected |
| [NVIDIA/Model-Optimizer](https://github.com/NVIDIA/Model-Optimizer) | 790916393 | 20/100 | detected |
| [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight) | 1086419061 | 20/100 | detected |
| [paperclipai/paperclip](https://github.com/paperclipai/paperclip) | 1170821064 | 20/100 | duplicate |
| [tensorflow/tensorflow](https://github.com/tensorflow/tensorflow) | 45717250 | 10/100 | detected |

Univer's 25 points comprise release 10, one HN story 5 and Trending presence 10. NVIDIA Model Optimizer and Hindsight each have release 10 + Trending 10. Paperclip also scores 20 and is correctly marked duplicate with its existing market link. TensorFlow has Trending presence only (10).

- Public leaderboard: three wallets covering all 19 finalized indexed launches; no excluded attribution. It includes existing settled reward claims without reducing lifetime earned fees. Observed values are live and continue changing with actual trades.
- `/explore`, `/discoverers`, `/api/growth` and signed-out `/operations/trends` returned 200; unauthenticated `/api/operations/trends` returned 401 with private/no-store. The public JSON contains curated data only and uses no-store.
- Verification: **16 focused tests + 1 disposable database integration + 1 migration upgrade test passed**; production build and staged secret scans passed. Integration additionally checks immediate first-buy `launched → active` evidence, tiny trades whose fees round to zero, and cap-crossing ambiguity. Desktop and 390px production Explore/leaderboard checks passed; wide tables scroll within their own container. The authenticated operator review UI was exercised locally with a synthetic session and public source fixture; production authorization and its live projection were checked read-only. No synthetic production session was created.
- Temporary local Next server and owned QA databases were stopped/removed. Browser QA pages were closed. No mainnet launch, trade, payout or liquidity action was executed by P6 verification.

Next operational step: review one current candidate at `/operations/trends`, approve it, and explicitly launch through the existing wallet flow. P3/P4 activation still follows the first-graduation runbook and is unaffected by P6.
