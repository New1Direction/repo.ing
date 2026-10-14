# Launch transparency

[Documentation](README.md) / Launch transparency

Release 2026-10-13 (migration `0071_launch_transparency`). repo.ing launches open-source repository markets on Meteora's bonding curve. This release makes how a market opened, who seeded it, how liquid it is, and how much of its trading is organic visible to everyone. It shows the evidence for each figure, says plainly what is unknown, and keeps money and placement out of it.

Ground rules this release follows:

- **Facts, not ratings to buy.** Every figure names its source and the time it was read. Unknown means unknown; it is never scored as zero or as a pass.
- **Never pay-to-rank.** Nothing anyone pays can change a report, a list position or eligibility: fees, tips, credits, Group launch raises or promotion. Lists are ordered by time, never by score.
- **Volume never earns anything.** Trading volume is not rewarded anywhere, so wash trading gains nothing. Round-trip and same-controller activity is measured so it can be excluded from metrics.
- **Same terms for every wallet.** No allowlists, hidden allocations, or private launch times. The one privileged position, the launcher's initial buy in the launch transaction, is capped, priced at the regular fee and, for a scheduled launch, announced in advance.
- **Not advice.** Token prices can fall to zero. A report describes public facts at one time; it is not an audit, an endorsement or a prediction of returns.

| # | Capability | Live in this release | Later |
| --- | --- | --- | --- |
| 1 | [Launch Quality report](#launch-quality-score) | Yes: worker-computed, evidence and unknowns, token page, API, read-only MCP (`launch_quality`) | — |
| 2 | [Calendar, watchlists, notifications, feeds](#scheduled-launches-and-the-launch-calendar) | Scheduled launches, `/launches`, JSON, Atom, iCalendar (all, or chosen repositories), webhooks filtered by kind and repository (off until a signing key is set) | Cross-device watchlist and browser push (phase 2) |
| 3 | [Transparent price discovery](#transparent-price-discovery) | Documented staged mechanism with each market's facts | On-chain batch auction (phase 3, new program) |
| 4 | [Seeded liquidity disclosure](#seeded-liquidity-disclosure) | Yes: labels, amounts, lock states, evidence | — |
| 5 | [Market-maker API and incentives](#market-maker-feed-and-incentives) | Live depth and spread API, hourly board, LP incentive **preview** | Funded incentives (phase 3) |
| 6 | [Anti-sniper protections](#anti-sniper-protections) | Launch fee, 3% cap, scheduled-launch gate | Per-wallet caps for every launch (phase 2/3) |
| 7 | [Fee rebates for two-sided liquidity](#fee-rebates-for-two-sided-liquidity) | Eligibility engine and **preview** (LP positions only) | Funded rebates (phase 3) |
| 8 | [Post-launch builder rewards](#post-launch-builder-rewards) | Metrics and **preview** assessment | Funded rewards (phase 3) |

## Launch quality score

`src/launch-quality.mjs` turns a market's facts into criteria. Each criterion is pass, caution, fail, unknown or info. Each carries points out of a maximum, the observed value, its evidence (source, link, time) and a note. The worker (`src/market-transparency.mjs`) recomputes each market's report about hourly and stores it in `launch_quality_reports`.

| Group | Criterion | Max | Pass | Caution | Fail |
| --- | --- | ---: | --- | --- | --- |
| Repository | Repository age (GitHub) | 10 | ≥ 180 days | 30–179 days (5) | < 30 days |
| Repository | GitHub stars | 10 | ≥ 100 | 10–99 (5) | < 10 |
| Repository | Commits in the last 7 days (Dev Pulse) | 5 | ≥ 1 | 0 (1) | — |
| Repository | Original repository (not a fork) | 5 | not a fork | fork (0) | — |
| Maintainer | Maintainer verification | 10 | verified by a current GitHub admin | — | not verified; or declined (flagged) |
| Launch | Initial buy at launch | 10 | ≤ 1% of supply | ≤ 3% (6); Group launch vault (5) | > 3% |
| Launch | Launch fee window against first-block bots | 5 | launch-fee config | flat fee (2) | — |
| Launch | Announced launch time | info | — | — | — |
| Token | Fixed supply, mint and freeze authority revoked (chain) | 10 | supply at or below one billion (burns are fine and shown) and both authorities revoked | — | supply above one billion, or an authority set |
| Token | Top 10 holders excluding curve, pool and lock escrows (chain) | 10 | ≤ 30% | ≤ 50% (5) | > 50% |
| Token | Launcher's indexed holding | 5 | ≤ 3% | ≤ 10% (2) | > 10% |
| Trading | Organic share of attributed volume | 10 | ≥ 80% | ≥ 50% (5) | < 50% |
| Liquidity | Executable depth within 2% of spot, lower side | 10 | ≥ 0.5 SOL | ≥ 0.1 SOL (6), > 0 (3) | none |
| Liquidity | Pool liquidity cannot be withdrawn by the team | 5 | curve reserve held by the program; or migrated liquidity locked (proof) | — | — |

- **Score:** points over the maximum of the *known* criteria, × 100. **Coverage:** the known criteria's maximum over the total maximum. With coverage below 60% there is no score ("Not enough evidence yet"). The score is always shown with its coverage and assessment time.
- **Unknown, not zero:** a criterion is unknown when its evidence is missing or stale: no Dev Pulse reading, the RPC holder read failed, a liquidity sample older than a day, fork lineage not checked, or less than 0.5 SOL of attributed volume for the integrity check. Unknowns are listed above the criteria.
- **Inputs:** `QUALITY_INPUTS` is the whole list. `launchQualityReport` ignores any other field, and `tests/launch-transparency.test.mjs` proves that paid fees, promotion, price, market cap, volume amounts, raise size and tips change nothing. The only volume figure used is the 0.5 SOL sample-size floor.
- **Where:** the token page "Launch quality" tab (`#transparency`), a link under Launch facts, `/launches` (recent launches with score and coverage), and `GET /api/v1/markets/<mint>/transparency`.

## Trading integrity

`src/trade-integrity.mjs` classifies every finalized swap (curve trades by pool; DAMM trades in the verified graduated pool):

| Class | Rule |
| --- | --- |
| Unattributed | The swap's owner is not indexed yet (older rows before trader backfill). Reported, never assumed organic; shares are of *attributed* volume. |
| Labeled | Owner is a repo.ing wallet (team, buyback, fee, launch signer, partner, tip, Group launch vault and signer) or the signed builder payout wallet (`app/lib/transparency-labels.mjs`). |
| Same transaction | The transaction both buys and sells this market: one signer on both sides. |
| Round trip | One controller buys and sells back (or sells and re-buys) within 60 minutes, FIFO-matched on SOL amounts; both legs count. |
| Organic | Everything else. |

### Linked wallets

A controller is a wallet or a cluster of wallets with public evidence of one controller (`src/wallet-clusters.mjs`):

- **Same transaction:** two different swap owners in one transaction signed together.
- **Operator record:** a `wallet_links` row with written evidence, for example a shared funding transaction. Records are added and removed with `scripts/wallet-links.mjs`; removal keeps history.
- **Platform:** all labeled repo.ing wallets are one controller.
- **Funding source** (`src/wallet-funding.mjs`, migration 0072): the worker reads where each active trading wallet's first SOL came from. It checks wallets that traded at least 0.1 SOL in 30 days, 20 per run, reading the first system transfer into the wallet in its oldest transactions. Two links follow:
  - **shared funder:** wallets funded by the same wallet, unless that funder looks like an exchange or another service (it funded 25 or more checked wallets, or has 1,000 or more transactions itself) or is a repo.ing wallet;
  - **direct funding:** a trading wallet funded by another trader of the same market.

  Wallets with 1,000 or more transactions are not traced (`long-history`): fresh wallets are what wash-trading setups create. `WALLET_FUNDING_LINKS=false` on the worker turns this off.

Wallets with no evidence stay separate. Linked activity is therefore undercounted, never invented. A link is evidence of a relationship, not proof of one controller: it only excludes activity from metrics and incentive previews, never blocks anyone, and the report shows how many links of each kind were found.

## Scheduled launches and the launch calendar

A current GitHub admin of a public repository without a market schedules its launch at `/launches/manage` (`src/launch-schedules.mjs`, `POST /api/launch-schedules`):

- **Time** at least 1 hour and at most 30 days ahead. The table enforces the notice too (`launch_schedules_notice_check`).
- **Window** of 15 minutes to 24 hours (default 2 hours).
- **The wallet that will sign the launch**, and **the most it will buy** in the launch transaction (≤ 1 SOL to announce; the launch still caps it at 3% of supply).
- An optional public note (holder-note rules: plain text, 280 characters, links only to github.com).

Every launch path reserves through the coordinator (`src/launch-coordinator.mjs`), which calls `assertScheduleAllows` under the repository lock:

- **Before the time:** nobody may launch the repository, not even the announced wallet (`LAUNCH_SCHEDULED`).
- **During the window:** only the announced wallet (`SCHEDULED_LAUNCHER_ONLY`), with at most the announced buy (`SCHEDULED_BUY_ABOVE_ANNOUNCED`), and never as a Group launch (`SCHEDULED_NO_GROUP_LAUNCH`). Opening a Group launch raise is refused too.
- **After the window:** the schedule lapses and the repository launches like any other.

A repository with a market, a launch in progress, an opt-out or a live Group launch cannot be scheduled. Cancelling is always allowed before launch. The worker marks schedules `launched` or `lapsed`. `/api/resolve` returns an announced schedule, so the CLI and agents see it before a review.

Scheduling is on unless `LAUNCH_SCHEDULES_ENABLED=false` on web. The gate always applies to schedules that exist.

**Calendar and notifications** (`/launches`, [Market data API](MARKET_DATA_API.md)):

- **Scheduled:** time, window, announced wallet, maximum buy, announcer and note.
- **Group launch raises:** deadline and target.
- **Launched this week:** each market's score and coverage, ordered by time.
- **Notifications:**
  - an iCalendar subscription (`/launches.ics`) that calendar apps poll, with a 15-minute alarm;
  - `/launches.ics?repos=<ids>` for chosen repositories; each listing's "Add to calendar" link;
  - an Atom feed and a JSON event stream;
  - signed webhooks filtered by event kind and repository ids.
- **Watching an upcoming launch:** add it to your calendar, or point a webhook at its repository id. The market watchlist (Explore, price alerts) is unchanged and stays in the browser (`docs/DISCOVERY_UX.md`). A cross-device watchlist is phase 2.
- Do-not-promote and maintainer-declined repositories are left out, as in launch alerts.

## Transparent price discovery

repo.ing runs no hidden allocation, so price discovery is public. `src/launch-mechanism.mjs` describes each stage for one market from its records. The token page shows the stages; they are also in the transparency API.

1. **Public announcement** (optional): the scheduled launch, with the same notice for everyone.
2. **Atomic launch transaction:** pool creation plus, at most, the launcher's own initial buy. It is capped at 3% of supply and pays the regular fee (`enableFirstSwapWithMinFee`). Nobody else can be in that transaction (`docs/LAUNCH_FEE.md`). A Group launch instead buys with the whole pooled raise in one swap, so every backer's SOL gets the same price; backers hold fee shares, not tokens (`docs/BUNDLE_LAUNCH.md`).
3. **Launch fee window:** 50.44% at activation, falling to 1.75% over 180 seconds, the same for every wallet.
4. **Contributor early access** (dark; `docs/EARLY_ACCESS.md`): a transfer-hook window with per-wallet caps.
5. **Public bonding curve:** one published price function. The price depends only on the reserve, so every buyer pays the same price at the same reserve.
6. **Graduation:** migration to DAMM v2, whose migrated liquidity is permanently locked.

**Why not a batch auction now:** a uniform-price opening auction for everyone needs a new on-chain program to collect bids, clear them and distribute tokens. Meteora's curve cannot run one, and the existing Group launch program pays backers fees, not tokens. Writing, auditing and deploying such a program is phase 3; it is not safe to fold into this release.

## Seeded liquidity disclosure

`src/seeded-liquidity.mjs` lists every position that entered a market at launch or from repo.ing. Each shows its label, wallet, amounts from finalized evidence and its lock state:

| Row | Lock state |
| --- | --- |
| Launcher's initial buy (labeled Builder when it is the signed payout wallet) | unlocked; also shows the launcher's current indexed holding |
| Group launch vault | program-controlled: no withdraw instruction, operator trades within on-chain limits; the program's upgrade authority could change it |
| Builder allocation (1%) | claimable after graduation by the verified builder; unlocked once claimed |
| Migrated liquidity (creator and partner positions) | permanently locked; fees claimable |
| repo.ing protocol liquidity (`liquidity_intents`) | withdrawable by the platform (`platform-authority` lock mode) |
| $REPOING team liquidity receipts | withdrawable by the platform until locked |

## Market-maker feed and incentives

- **Live:** `GET /api/v1/markets/<mint>/liquidity` comes from one pool snapshot and the Meteora SDK's exact integer quotes (`src/market-liquidity.mjs`), cached 10 s. It returns:
  - spot price and the current fee;
  - **depth** within 1%, 2% and 5% on each side: the largest buy (SOL) and sell (tokens) whose average price before fees stays within that distance of spot;
  - the **quoted spread** at 0.1 and 1 SOL: buying that much and selling the same spot value back right now, fees included.

  The validator test executes swaps of exactly the published size and receives exactly the published amount.
- **Hourly:** the worker stores a sample per market in `market_liquidity_samples` (2% depth, 0.1 SOL spread, fee, reserve, two-sided flag). `GET /api/v1/liquidity` lists the latest sample per market, ordered by depth, with 30-day sustained figures:
  - **uptime:** the share of samples with ≥ 0.1 SOL on each side within 2% and a spread ≤ 10%;
  - median depth and median spread.
- **Who can provide liquidity:** before graduation, nobody can add liquidity; the curve is the only liquidity. After graduation, anyone can open a DAMM v2 LP position. The worker samples every position in each graduated pool hourly (`src/lp-positions.mjs`, `lp_position_samples`), attributed to the position NFT's holder.
- **Incentive preview** (`src/liquidity-incentives.mjs`): each owner's 7-day time-weighted share of pool liquidity × uptime. A DAMM v2 position quotes both sides across the pool's whole price range, so quoted spread is the pool's own fee for every LP. Depth contributed is the share times the pool's depth. Exclusions are listed under [fee rebates](#fee-rebates-for-two-sided-liquidity). **No incentive budget exists and nothing is paid.**

## Anti-sniper protections

Live and unchanged: the launch fee window (`docs/LAUNCH_FEE.md`), the 3% launch-buy cap at the regular fee (`docs/LAUNCH_REVIEW.md`) and the atomic launch transaction.

New: scheduled launches. Everyone gets the same notice. Nobody can launch before the time. Only the announced wallet, with its announced maximum, can launch during the window. That removes the race to be first to create a scheduled market, without giving anyone hidden access: the privileged wallet and its limit are public in advance.

Not live: per-wallet caps for every launch. DBC pools cannot cap wallets; the early access transfer hook can, but it is dark pending its own activation (`docs/EARLY_ACCESS.md`).

## Fee rebates for two-sided liquidity

Only genuine two-sided liquidity qualifies, meaning a DAMM v2 LP position. A position is excluded when:

- **labeled:** its owner is a repo.ing or builder wallet, including repo.ing's locked migration positions;
- **circular-volume:** its controller round-tripped or traded both sides in one transaction in that market for ≥ 0.5 SOL or ≥ 20% of its own volume. LP fees farmed by trading against your own position are circular;
- **owner-unknown:** the NFT holder could not be read.

Trading volume never qualifies. Self-trades, same-controller and linked-wallet activity and circular volume are excluded by construction. The engine is live and its output is published as a preview; rebates are not funded or paid.

## Post-launch builder rewards

`src/market-health.mjs` measures:

- **Sustained liquidity:** the median of the lower side's 2% depth over 30 days, uptime and sampling coverage.
- **Holder diversity:** controllers holding at least 10,000 tokens, effective holders (inverse Herfindahl index), and the top 10's share of community holdings. Clusters merge linked wallets; labeled wallets never count.
- **Retention:** the share of first-week buyers still holding after 30 days, and of holders 30 days ago who still hold.

The preview assessment (`BUILDER_REWARD_RULES`) passes a market only when all of these hold:

- the market is at least 30 days old;
- at least 50% of hourly samples were taken;
- median depth is ≥ 0.5 SOL on each side;
- uptime is ≥ 90%;
- it has ≥ 20 effective holders;
- ≥ 30% of first-week buyers are still holding;
- ≥ 70% of volume is organic.

First-hour volume, total volume, price, market cap and fees paid are excluded. **Status: preview, `paid: false`.**

Limits: holdings come from indexed swaps, so tokens moved by plain transfer are not seen. Splitting a position across unlinked wallets can raise effective holders; the 10,000-token floor and the 30-day retention make that costly but not impossible.

## Follow-up phases

| Phase | Work | Why it is not in this release |
| --- | --- | --- |
| 2 | Cross-device watchlist and browser push notifications | Needs accounts or signed wallet storage, a service worker, VAPID keys and consent UI |
| 2 | Per-wallet caps at launch via the early access hook | Gated by the early access activation plan |
| 3 | On-chain batch auction (uniform clearing price, pro-rata tokens) | New Solana program: design, audit, deployment and migration |
| 3 | Funded LP incentives, fee rebates and builder rewards | Needs a funding source decision, payout signer custody, claim flow and reconciliation, like other payouts |

## Operating

**Deploy**

1. Web first: its pre-deploy applies migration 0071, which is additive and idempotent.
2. Then the worker.

Before the worker runs, the calendar shows scheduled launches but no reports or samples ("Not assessed yet"). The token page and the APIs keep working.

**Environment**

| Variable | Service | Default | Effect |
| --- | --- | --- | --- |
| `LAUNCH_SCHEDULES_ENABLED` | web | on | `false` pauses new schedules; cancelling and the gate still work |
| `MARKET_TRANSPARENCY_SAMPLING` | worker | on | `false` stops liquidity and LP sampling, funding-source checks and reports; the feed, schedules and webhooks still run |
| `WALLET_FUNDING_LINKS` | worker | on | `false` stops only the funding-source checks |
| `LAUNCH_WEBHOOKS_ENABLED` | web, worker | off | `true` (with a key) turns on webhook management and delivery |
| `LAUNCH_WEBHOOK_SIGNING_KEY` | web, worker | none | Base64 32-byte Ed25519 seed (or a PKCS#8 PEM). The public key is served at `/api/v1/webhooks/signing-key` |

**Run bounds:** each run spends at most 100 seconds on sampling and reports, then leaves the rest for the next run. Each market or wallet gets at most 45 seconds, and every chain read times out after 15 seconds, so an RPC call that never answers cannot stall the job (a stall like this held the first production runs for 19 minutes on 2026-10-14). Order: liquidity samples, reports, LP scans, then funding traces.

**Worker cost:** each 2-minute run samples up to 20 markets' liquidity (two RPC reads each) and up to 5 graduated pools' LP positions (one program scan plus a read per position, at most 200). It also traces up to 20 trading wallets' funding (two to four reads each) and writes up to 10 reports; each report reads the holder snapshot (three RPC reads) and the market's swaps. Every market is refreshed about hourly. Samples older than 120 days are deleted.

**Operator wallet links:** run `node --env-file=.env.local scripts/wallet-links.mjs add <walletA> <walletB> "<evidence>"`, plus `list` and `remove`.

## Verification

- `tests/launch-transparency.test.mjs` (quick suite):
  - clustering, round-trip windows, integrity totals;
  - depth tightness and spread on a constant-product pool;
  - quality points, coverage and never-pay-to-rank;
  - health, retention, LP exclusions;
  - schedule validation and gate;
  - feed formats, webhook URL and IP guards, signatures;
  - seeded rows.
- `tests/launch-transparency-db.test.mjs` (PostgreSQL):
  - schedules and constraints;
  - feed idempotence, exclusions and calendar;
  - webhook fan-out, backoff and pausing;
  - the stored report from seeded swaps, links and samples.
- `tests/launch-transparency-chain.test.mjs` (validator):
  - a scheduled launch through the production coordinator: refusals reserve nothing;
  - the published curve depth executed exactly on both sides;
  - integrity from indexed swaps, including a two-wallet transaction;
  - after a real migration, the DAMM depth executed exactly and LP positions attributed to their NFT holders, with the incentive preview.
- `tests/bundle-raise.test.mjs`: a Group launch raise is refused during a schedule.
