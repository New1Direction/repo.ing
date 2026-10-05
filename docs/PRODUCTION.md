# Production setup

[Documentation](README.md) / [Environment reference](DEVELOPMENT.md#environment-reference)

## Services

repo.ing runs a Next.js web service, a persistent indexing worker, PostgreSQL, and a separate encrypted backup job. The hosted installation uses Railway for those services and Cloudflare for its domain and backup storage.

| Service | Command / configuration | Responsibility |
| --- | --- | --- |
| Web | `npm run build`, then `npm run start` | Interface, API routes, wallet transaction preparation, GitHub verification, protected payout signing |
| Worker | `npm run worker` | Finalized launch/trade indexing, fee evidence, signed-intent recovery, and reconciliation |
| PostgreSQL | Apply the committed Drizzle migrations | Durable intents, indexed evidence, identity, and derived accounting |
| Backup | Separate image in `backup/` and an external schedule | Stream a logical database snapshot into encrypted off-host storage |

## Configuration

Use [`.env.example`](../.env.example) and the [development environment reference](DEVELOPMENT.md#environment-reference). Keep credentials in the deployment provider's secret store.

- Web and worker must agree on the network, active `DBC_CONFIG`, and approved legacy configs. Existing markets retain their original economics.
- Set `APP_ORIGIN` to the canonical HTTPS origin. GitHub OAuth callbacks and wallet challenges must use the same origin.
- The GitHub App requires Metadata read permission. Review [GitHub authority verification](GITHUB_VERIFICATION.md) before provisioning it.
- Creator and partner secrets belong only on the protected web service. The worker recovers previously authorized intents without receiving signer secrets.
- The backup job receives database access, an encryption recipient, and scoped object-storage credentials. Keep its decryption key outside the backup service and storage account.
- Restrict treasury operations using `PLATFORM_OPERATOR_GITHUB_IDS`. An empty allowlist denies access.

## Release sequence

1. Verify the exact source revision, lockfile, focused checks, and production build. Never run destructive fixture tests against production.
2. Check a recent encrypted backup and a tested recovery path before schema changes.
3. Apply required additive migrations using the reviewed database target. Preserve evidence and existing market records.
4. Deploy a compatible worker, then web. Record each deployed revision and verify loaded settings without exposing secrets.
5. Confirm the public launch, market, Explore, and builder pages respond. Verify operator endpoints reject anonymous access.
6. Observe finalized indexing across existing markets, worker recovery after restart, and builder/platform/liquidity reconciliation. Investigate disagreements before financial activation.

A Git push saves source; it does not by itself establish a successful production rollout. Database migrations and deployment are separate operations. Documentation-only cleanup does not require a runtime deployment.

Optional [agent launch reviews](AGENT_LAUNCH.md) require migration `0022`, a dedicated web-only `AGENT_LAUNCH_SECRET`, and `AGENT_LAUNCH_ENABLED=true`. Default is disabled. The new tools prepare review links and read indexed status; they never sign or submit a launch. Verify the endpoint and browser handoff before activation. Shared request quotas fail closed when the database is unavailable.

## Financial execution gates

Keep these settings explicitly disabled until their separate activation requirements are met:

```dotenv
REPO_BUYBACK_EXECUTION_ENABLED=false
REPO_LIQUIDITY_EXECUTION_ENABLED=false
BUILDER_REINVEST_ENABLED=false
```

- **Buybacks:** require a verified canonical mint, reviewed executor and venue, explicit limits, and a successful bounded rehearsal. The current release does not execute purchases.
- **Protocol liquidity:** the first deployment requires a verified graduated pool and eligible claimed, allocated revenue. Manually review and simulate an intent capped at **0.05 SOL investment + 0.012 SOL account/network overhead**; verify exact wallet/token/LP deltas and reconcile `MATCH`.
- **Builder Reinvest:** remains disabled until the first verified non-zero protocol liquidity deployment returns `MATCH`. Builder fees must settle to the builder wallet first; investing requires a separate explicit signature.

Follow the [first-graduation runbook](FIRST_GRADUATION_RUNBOOK.md), [bounded liquidity runbook](P3_FIRST_LIVE_RUNBOOK.md), and [revenue policy](REVENUE_POLICY_V1.md). No automatic market selection or spending is authorized by a deployment.

## Monitoring and recovery

Watch indexing freshness, migration evidence, reconciliation failures, and payout recovery. Operator-only [reserve alerts](RESERVE_ALERTS.md) report meaningful reserve changes; [graduation readiness](FIRST_GRADUATION_READINESS.md) covers threshold and migration alerts.

Preserve durable intents and settlement evidence through restarts and rollbacks. Never manually mark an unsettled financial action complete or alter a ledger to force `MATCH`. Restore a compatible prior application release when necessary; schema rollback and data recovery need their own reviewed procedure.

A database restart, failover or dropped connection does not stop the web or worker process (`src/database-pool.mjs`). A connection lost while idle, or checked out between statements, logs `{"databaseConnectionError":{"code":…}}` (`57P01` when the server ended it). One lost during a statement fails that statement to its caller and may log only `Connection terminated unexpectedly`, or nothing when the statement ran through `pool.query`. The next query opens a new connection.

Use [encrypted backups](BACKUPS.md) for recovery. Keep recovery keys available outside the application host and verify restores into a disposable database before a cutover.

## Deploy-safe trades and the trade canary

Migration `0029_trade_sessions` stores each prepared trade (unsigned transaction, exact reviewed message, amounts, blockhash window, pool/vault/mint/referral pins, and later the first accepted signature and result) in `trade_sessions` for 10 minutes. Any web instance, including one started by a deploy, can submit and verify a trade another instance prepared; the 2-minute submit window, the reviewed-message/Lighthouse check, fee-payer and signature checks, and receipt verification are unchanged. The in-process Map is only a cache. If the database is unreachable at prepare, that session falls back to the old in-process behavior.

Migration `0043_trade_referrers` adds `trade_referrers`, the public referral leaderboard's only source: one row per site trade whose swap receipt verified against its own prepared record and which paid a referral (signature, referrer wallet, repository, phase, direction, quoted trading fee; never the trader's wallet). Rows are written best effort after verification; a missing table or failed insert is logged and never changes the trade result. `/referrals` reads it through a one-minute in-process memo. Apply it before deploying this web version (the web pre-deploy `db:migrate` does). Drizzle only applies migrations newer than the last one recorded, so `0040`–`0042` (if they ship separately) must be applied before `0043` or be re-stamped after it.

Zero-downtime web deploys: `GET /api/health` returns 200 once the process serves and the database answers (503 otherwise). The web service is configured in Railway settings, not a config file (Railway no longer accepts config-as-code for new setups): variables `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=30` and `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=150`, plus Settings → Deploy → Healthcheck Path `/api/health`, timeout 300. Only the web service gets the healthcheck; the worker serves no HTTP. `next start` drains in-flight requests on SIGTERM; 150 draining seconds covers the longest submit (rebroadcast, confirmation, finality wait).

The worker's trade canary runs every 5 minutes (`TRADE_CANARY_ENABLED=false` disables it): for $REPOING's DAMM market and the two most-traded active curve markets it runs the real prepare path for a 0.01 SOL buy with the team wallet as the unsigned fee payer, then only simulates — plain, and with a Phantom-style Lighthouse assertion appended, which the review check must accept and which must fit the prepared compute-unit limit. Nothing is signed or sent. Results appear under Canary on `/operations/health`; two consecutive failures of a market, or every market failing in one run, raise one `TRADE_CANARY_FAILING` alert per hour.

## Running more than one web replica

From migration `0036_launch_sessions` on, the web service is replica-safe: no request depends on reaching the replica that served an earlier request. Apply `0036` before deploying this web version (launch prepare needs the table). State that must be shared lives in PostgreSQL:

- **Launch reviews** (`launch_sessions`): `prepare` reserves and prepares the market under the repository's advisory lock and stores the review (unsigned transaction, mint, blockhash window, config, initial buy, trend revision) with a 2-minute expiry from the database clock. `submit` or `cancel` on any replica consumes it exactly once (`UPDATE … WHERE consumed_at IS NULL`), then `submit` re-checks the market under the lock and runs the same co-sign/submit/evidence path as before. The fresh mint's secret key is the only secret: it is stored AES-256-GCM sealed with a key derived from `PLATFORM_CREATOR_SECRET_KEY` (bound to the session id and mint) and erased when the review is consumed. Expired reviews are deleted, and their still-`prepared` market marked `failed`, by web requests and by every worker pass. The lock is no longer held while the wallet is open, so a second `prepare` for the same repository during an open review is refused ("awaiting wallet approval") instead of waiting. Rotating the creator key invalidates open reviews (users re-review).
- **Trades** (`trade_sessions`, above), **wallet challenges**, **holder-note / X-link / agent quotas** and the **Parts pledge prepare throttle** (`agent_request_limits`; 240/min overall, 12/min per client, 6/min per wallet) are database-backed. GitHub and X OAuth state rides in sealed cookies.
- **Live market updates** come from PostgreSQL `NOTIFY` triggers; each replica holds its own `LISTEN` connection, so every replica sees every update.

Per replica by design (correct with any number of replicas): short-TTL read caches (market list 15 s, Explore growth surface 15 s, chart payloads 3 s (dropped on the replica's own trade hint), holder counts 5 min, X handles 60 s — an unlinked handle can show on another replica for up to a minute — holder balances, repository images/logos, SOL price, release notes), the per-process concurrency caps (repo search 4, image uploads 2, 500 live-update viewers), the [request limits](#request-limits), the CSP-report limiter, and the CSP counters on `/operations/health` (they describe only the replica that served the page). If PostgreSQL is unreachable at trade prepare, that one trade falls back to in-process memory and can only be submitted on the same replica. Each replica opens its own connection pool plus one `LISTEN` connection; size `max_connections` for the replica count.

## Request limits

The public trade, launch and repository-lookup routes give each address an allowance per action (`app/lib/request-limits.mjs`): a burst it may spend at once, and a rate after that. This keeps one address from spending the RPC and GitHub budgets that every other request and the worker share. Over its allowance an address gets HTTP 429 with `Retry-After` (the seconds until one more request is allowed, 1 to 10) and `{"error":"Too many requests. Try again in 8 seconds.","code":"RATE_LIMITED"}`, naming the same wait.

There is no site-wide total. Addresses are counted apart, so one visitor's requests can never get another visitor refused.

| Action | Burst | Per minute after that | What one request costs |
| --- | ---: | ---: | --- |
| `/api/trade` `quote` | 120 | 120 | about 3 RPC calls |
| `/api/trade` `costs` | 120 | 60 | about 15 RPC calls |
| `/api/trade` `depth` | 30 | 30 | up to 3 RPC calls, cached 10 s |
| `/api/trade` `prepare` | 20 | 20 | about 16 RPC calls and a trade session |
| `/api/trade` `status` | 120 | 120 | a few RPC calls |
| `/api/launch` `quote` | 40 | 40 | 1 RPC call |
| `/api/launch` `prepare` (GitHub repositories) | 30 | 6 | 3-4 GitHub calls, about 10 RPC calls, and the repository reserved for 2 minutes |
| `/api/resolve` (when GitHub must be asked) | 30 | 8 | up to 3 GitHub calls |

- **Sizing:** each burst is at least four times the heaviest honest use by one visitor in a minute, and each rate is above one heavy visitor's, because many people can share one address (an office, a VPN exit, a mobile carrier). The trade panel refreshes a typed quote and its costs every 15 seconds and after each edit, and polls a signed trade every 3 seconds; the launch form asks for a fresh review every 20 seconds while one is being read. The two actions that read GitHub refill slowest: its budget is 5,000 calls an hour for the web and the worker together.
- **Where a request is counted:** before the route reads the chain or GitHub. `/api/trade` checks the direction and slippage first. `/api/launch` `prepare` is counted before the pair's owner is looked up. `/api/resolve` answers a market it already knows from the database without counting.
- **What a refusal looks like:** the trade panel shows the message and asks again on its next 15-second refresh; a refused costs preview shows as unavailable and the trade is still checked at prepare. The launch form asks for a refused initial-buy quote again by itself, and offers "Refresh review" for a refused review.
- **Never limited:** a signed trade or launch (`submit`), releasing a review (`cancel`), and reading a launch's status. Model launches keep their own Hugging Face lookup quota.
- **Not covered by these allowances:** Blink trades (`/api/actions/*`, whose clients often share a proxy address), wallet balance reads, the launch page's own repository read and `/api/repos/<id>/quote-options`.
- **The address** (`src/client-address.mjs`) is Cloudflare's `CF-Connecting-IP`, else the first `X-Forwarded-For` entry, else `X-Real-IP`. An IPv6 address counts as its /64, and an IPv4 address written as IPv6 as that IPv4 address. A request with no address at all is not limited. The address groups requests; it is not authentication. A request sent straight to the Railway service domain can claim any address and so gets a fresh allowance each time: the allowances stop one ordinary source, not someone who goes around Cloudflare.
- **The older per-visitor quotas** (holder notes, web vitals, the MCP and CLI endpoints, Hugging Face lookups, X linking, parts-fund pledges, CSP reports) read the same address. They used the first `X-Forwarded-For` entry, which through Cloudflare is whatever the client sent.
- **Counts live in each web process.** A deploy starts them over, and with several replicas each keeps its own.
- **Log:** while an action refuses, one line a minute: `{"requestLimited":{"action":…,"refused":…,"addresses":…}}`, the requests refused and the addresses they came from since the previous line. Addresses themselves are never logged or stored.
- **A fault in the limiter never refuses a request:** it logs `{"requestLimiterFault":…}` and the request proceeds.
- `REQUEST_LIMITS_DISABLED=true` on the web service turns every allowance off. Setting it restarts the service.

## Chart ordering verification

Graduated charts also index the verified DAMM destination's swap prices. Migration proof must bind the same repository, curve, mint, destination, slot, and receipt before DAMM history is included. Missing price or transaction-order evidence withholds affected prices while retaining verified volume. Apply migrations `0020` and `0021` before deploying this worker/web version.

Optional [builder email reminders](BUILDER_REMINDERS.md) remain disabled unless a verified sender, secret, provider key, and explicit delivery gate are configured. They do not authorize claims, trades, or reinvestment.

The worker fills `finalized_chart_blocks` for indexed slots with multiple transactions. It requires agreement from the primary and graduation-verification RPCs on mainnet genesis, finalized block identity, and the complete ordered signature list. Conflicting evidence is never overwritten. Once every indexed trade in a block has its stored position and the block is seven days old, its signature list is cleared to an empty array (`pruneChartBlocks`). A trade indexed later in it makes the block pending again, and the list is restored from a fresh two-RPC proof of the same block. Work is capped at 12 slots per pass, with a ten-minute retry delay for unavailable slots, independently of fee indexing.

The chart joins this evidence to finalized swaps to recover candle opens and closes. Missing or disagreeing evidence keeps affected boundary-slot prices withheld; recorded volume remains unchanged. Worker logs expose `chartOrdering.verified`, `pending`, and sanitized error codes. This table does not allocate funds or enable execution.

If the verification provider has pruned an old block, keep its prices withheld. A bounded operator backfill may use another independently operated mainnet RPC with `verifyChartBlock` and `recordChartBlock`; the exact same genesis, finalized block, signature membership, and ordering checks still apply. The September 27 backfill used Solana’s public mainnet RPC to corroborate OHIYO slot `450228550`, which the normal secondary had pruned. No production RPC or financial gates were changed.

## Wallet P&L attribution

Migration `0026_trade_traders` adds nullable `trader` to `trade_events` and `damm_trade_events` plus `base_amount` on DAMM rows. The worker records the swap's signing payer, or the transaction fee payer when an aggregator routes through a non-signing authority. `/wallet` shows average-cost P&L per holding from those rows only; unexplained tokens are marked partial and never counted as profit. Rows indexed earlier stay NULL until `node scripts/backfill-trade-traders.mjs` (read-only RPC, `--dry-run` first) replays their signatures; it only fills NULL columns and refuses rows whose replayed amounts differ.

## Market display updates

Migration `0023_market_update_notifications` adds commit-time invalidation triggers to finalized indexed trade and graduation-observation tables. The web service shares one dedicated PostgreSQL `LISTEN` connection across its viewers, and `/api/market/[mint]/events` streams only public market identifiers and change types. Stream events request a fresh read through the existing canonical APIs; they never set a price, balance, fee credit, or settlement state themselves.

Streams close when the browser tab is hidden, coalesce indexing bursts, reconnect with a resync, and keep 60-second polling as a fallback. Each web process caps viewers at 500; an idle listener closes after 30 seconds. No worker restart is needed for the triggers. Notifications are transient, so recovery always reads durable indexed evidence. The listener never opens a database transaction; watch `pg_notification_queue_usage()` and listener connection health if investigating delayed updates. Disable the `repoing_*_update` triggers (`repoing_trade_update`, `repoing_damm_update`, `repoing_curve_update` and `repoing_live_trade_update`; for stock pairs `repoing_stock_trade_update` and `repoing_stock_fee_update`) to stop hints without removing indexed records; polling remains available.

Quotes return price estimates independently of account/network cost previews. The `costs` action is read-only and creates no signing session. The existing `prepare` action still re-quotes, checks exact funding and simulates the unsigned transaction before requesting a wallet signature. Public chart preloading is limited to two concurrent requests and 12 entries, expires after eight seconds, and always revalidates on opening a market. It never supplies trading or payout authority.

## Launch alerts

The worker can post one short message per new market to a Telegram channel and/or an X account (`src/launch-alerts.mjs`, migration `0034_launch_alerts`). A market qualifies once it is `confirmed`, indexed and `finalized`, was indexed at or after `LAUNCH_ALERTS_SINCE`, and was indexed within the last 24 hours. The text is the repository, ticker, stars, a one-line description (links, control characters and `@`/`#`/`$` prefixes removed; truncated so X posts stay within 280 characters) and the token page link. A market whose repository is new (created in the last 30 days or under 10 stars) is posted only once it has [earned promotion](#repository-quality-signals-and-official-markets) within those 24 hours; otherwise there is no moderation flag, so every qualifying market is posted.

Each post is claimed in `launch_alerts` (unique per repository and channel) before it is sent, and runs hold an advisory lock, so overlapping workers or redeploys never post twice. A provider rejection (4xx, including 429, or a refused connection) is `failed` and retried after at least five minutes, up to 3 attempts. A timeout, 5xx, malformed success or a crash mid-send may have posted, so the row becomes `unknown` and is never retried automatically. Each run (about once a minute) posts at most 2 per channel, 10 seconds apart, and `LAUNCH_ALERTS_MAX_PER_DAY` (default 15) per channel per 24 hours. The X API is pay-per-use: every post here carries a link, which X bills from prepaid credits (about $0.20 a post on the October 2026 price list), so the X caps set the spend ([ALERTS_SETUP.md](ALERTS_SETUP.md#safe-caps)).

Hugging Face model markets are posted too when the worker has `HF_MARKETS_ENABLED=true`; keep it the same as on web, since model posts link to model pages. A model post names the model by its Hugging Face id and shows its likes (read once from the Hub when posting, display only; left out when the Hub does not answer within 5 seconds), its stored task and license, and the short "not affiliated" disclaimer. Model markets carry no stars, so each is posted only once it has earned promotion (10% of its target within 24 hours).

The owner's step-by-step guide is [ALERTS_SETUP.md](ALERTS_SETUP.md). `node scripts/alerts-check.mjs` checks the settings and keys without posting (the X account and its access level, the Telegram bot's posting rights), and `node scripts/alerts-preview.mjs` prints the exact texts the next runs would send from read-only queries.

Setup (worker variables only; nothing posts until every step is done):

1. Telegram: create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy its token to `TELEGRAM_BOT_TOKEN`. Create the public channel, add the bot as an administrator allowed to post, and set `TELEGRAM_CHAT_ID=@channelname` (a private chat's numeric id such as `-100…` also works, but then no post links are recorded).
2. X: in the [X developer portal](https://developer.x.com), create a project and app. Under User authentication settings set App permissions to **Read and write** before generating tokens. From Keys and tokens copy the API Key and Secret to `X_BOT_API_KEY`/`X_BOT_API_SECRET`, then generate the Access Token and Secret while signed in as the posting account and copy them to `X_BOT_ACCESS_TOKEN`/`X_BOT_ACCESS_SECRET`. Tokens generated before switching to Read and write stay read-only; regenerate them. These are not the `X_CLIENT_ID`/`X_CLIENT_SECRET` used for Connect X.
3. Set `LAUNCH_ALERTS_SINCE` to the current UTC time, e.g. `2026-10-01T00:00:00Z`, so existing markets are never announced, then set `LAUNCH_ALERTS_ENABLED=true`. A channel with only some of its variables, or a missing/invalid cutoff, logs `launchAlertError` once at startup and posts nothing.

Verify: at startup an enabled worker logs one `{"launchAlertsOn":{…}}` line (channels, cutoff, daily cap, models); it logs `{"launchAlerts":{"posts":[…]}}` when it posts (status `sent` with the post URL, `failed` with the provider error, or `unknown`), the same line when it marks an interrupted claim `unknown` or its migration is missing, and `{"launchAlertError":"LAUNCH_ALERTS_UNAVAILABLE"}` when a run fails; it is silent otherwise. Check rows with `select channel, status, attempts, message_url, error, created_at from launch_alerts order by id desc limit 20`. For an `unknown` row, look at the channel: if the post is missing and should go out, delete the row to allow one new attempt; if it posted, leave the row. Setting `LAUNCH_ALERTS_ENABLED=false` stops new posts immediately on the next worker restart.

## Do-not-promote list

`PROMOTION_EXCLUDED_REPO_IDS` (web and worker) is a comma-separated list of GitHub repository IDs that repo.ing must never promote: they are hidden from `/waiting` (no "Tag them on X" prompt) and must be skipped by any feature that features or announces markets. The graduation race (home and `/explore`) and the $REPOING page's "Repo markets to watch" leave them out, and graduation milestone alerts never post them. Their markets and builder fees are unaffected. Use it when a maintainer asks not to be contacted or promoted, or when promoting a repository would be inappropriate.

Maintainers can also do this themselves (`src/maintainer-opt-outs.mjs`, migration `0041_maintainer_opt_outs`). A current GitHub admin can decline a repository's market from its claim page or the Builder dashboard, or opt a repository without a market out at `/opt-out`. While that decision is active the repository is treated exactly like a listed ID everywhere above (plus the home market lists, "More repo markets", Explore highlights, `/find-repos`, trending launch suggestions, Dev Pulse and both alert jobs), its token page shows "The maintainer of … has declined this market" with their optional note, and `/api/resolve`, `/api/launch` and agent drafts refuse to launch it. The market keeps trading and its builder fees stay claimable. Every change re-checks the admin's GitHub permission; withdrawing restores normal behavior and keeps the old row as history. Active decisions: `select github_repo_id, kind, note, created_at from maintainer_opt_outs where withdrawn_at is null`.

## Graduation milestone alerts

The worker can also post when a market first passes 25, 50, 75 or 90% of its graduation target, and when it graduates, to the same Telegram/X channels as launch alerts (`src/milestone-alerts.mjs`, migration `0037_milestone_alerts`). Posts read like:

```text
📈 $RCAT passed 50% of the way to graduating on repo.ing — 42.5 SOL to go.
New1Direction/webmcp-anything
https://repo.ing/token/<mint>

🎓 $RCAT graduated to Meteora after reaching its 85 SOL target on repo.ing.
New1Direction/webmcp-anything
https://repo.ing/token/<mint>
```

With `HF_MARKETS_ENABLED=true` on the worker, Hugging Face model markets get the same posts, naming the model by its Hugging Face id and carrying the short disclaimer; their first sight after that switch only takes a mark.

Progress comes only from the graduation monitor's `VERIFIED` observations that pass the public curve endpoint's freshness gate (at most five minutes old), compared as exact lamport ratios against each market's own target. A stale or under-review market is skipped until it is fresh again. A curve that reached its target but has not migrated posts nothing until the migration evidence is recorded; then it posts the graduation. Repositories on the [do-not-promote list](#do-not-promote-list) are never posted and keep no milestone marks (each run drops them, including marks taken before the repository was listed), so one taken off the list starts from a fresh mark and nothing from its excluded time is announced.

Old crossings are never posted. The first time a channel sees a market (fresh, at or after `GRADUATION_ALERTS_SINCE`), the job records the milestone the market has already reached in `milestone_alert_marks` and posts nothing. So turning the job on, or adding a channel later, announces nothing that already happened, and a market first seen at 30% gets no 25% post. After that, a milestone is posted only when it is above the mark and above every milestone already claimed on that channel: a jump from 20% to 80% posts 75% only, and falling back and re-crossing posts nothing. Marks recorded before the current `GRADUATION_ALERTS_SINCE` are re-taken (never lowered), so moving the cutoff forward when re-enabling after a pause also skips crossings from the pause.

Each post is claimed in `milestone_alerts` (unique per repository, channel and milestone) before it is sent, under its own advisory lock, with the same outcome handling as launch alerts: `failed` retries at least five minutes apart (or after the provider's rate-limit reset), up to 3 attempts; `unknown` is never retried; at most 2 posts per channel per run (about once a minute), 10 seconds apart. `GRADUATION_ALERTS_MAX_PER_DAY` (default 10) caps milestone posts per channel per 24 hours, separately from `LAUNCH_ALERTS_MAX_PER_DAY`; on X the two caps together set the daily spend of prepaid API credits ([ALERTS_SETUP.md](ALERTS_SETUP.md#safe-caps)).

Setup (worker variables only; the channel credentials are the launch-alert ones above, and the two switches are independent):

1. Apply migration `0037_milestone_alerts`.
2. Set `GRADUATION_ALERTS_SINCE` to the current UTC time, e.g. `2026-10-01T00:00:00Z`, then set `GRADUATION_ALERTS_ENABLED=true`. A channel with only some of its variables, or a missing/invalid cutoff, logs `milestoneAlertError` once at startup and posts nothing. The job does nothing at all before the cutoff.

Verify: at startup an enabled worker logs one `{"milestoneAlertsOn":{…}}` line. The first run posts nothing and fills `milestone_alert_marks` (`select channel, milestone, count(*) from milestone_alert_marks group by 1, 2 order by 1, 2`). The worker logs `{"milestoneAlerts":{"posts":[…]}}` when it posts, the same line when it marks an interrupted claim `unknown` or its migration is missing, and `{"milestoneAlertError":"GRADUATION_ALERTS_UNAVAILABLE"}` when a run fails; it is silent otherwise. Check rows with `select channel, milestone, status, attempts, message_url, error, created_at from milestone_alerts order by id desc limit 20`. For an `unknown` row, look at the channel: if the post is missing and should go out, delete the row to allow one new attempt; if it posted, leave the row. Setting `GRADUATION_ALERTS_ENABLED=false` stops new posts on the next worker restart.

## Repository quality signals and Official markets

Repositories made only to launch a coin are labeled and not featured until their market earns it (`app/lib/repo-quality.mjs`):

- **New repo:** created on GitHub less than 30 days ago, or fewer than 10 stars (stars alone decide while the creation time is unknown). Until its market earns promotion (below) it is labeled on Explore and "More repo markets" and its row in the token page's Launch facts is amber; the label then goes, while Launch facts keep showing age, stars and the repo score for every market. Launch review shows age and stars with a note. Launching is never blocked.
- **Earned promotion:** not a new repo, or fresh verified curve progress at 10% of the market's own graduation target, or graduated. Only markets that earned it are featured: the home page's Explore repositories, Live from GitHub ticker, Shipping hardest and Official launches, the $REPOING page's newest launches, and launch alerts. The graduation races (home, `/explore`, and the $REPOING page's "Repo markets to watch") rank every market by verified progress and label new repositories instead of hiding them. The `/explore` market list shows every market but sorts the rest last in Trending. Milestone posts start at 25%, so they are always for markets that earned it.
- **Official:** a verified admin's bound payout wallet is the market's launch wallet (the maintainer launched it). Shown in the token page header and market rows, filterable on Explore, and the home page lists up to four of the newest.

Migration `0045_repo_quality` adds the nullable `repositories.github_created_at`. Apply it before this worker version: the web's pre-deploy migration does it, and until it has run the worker's Dev Pulse and launch-alert passes log errors and retry. Creation times fill in as GitHub is next read: launches and repository lookups store them, and each Dev Pulse check reads a repository once without its cached validator while its creation time is unknown (one extra rate-limited request per live market, spread over the normal check schedule). That check also keeps `repositories.stars` and `forks` current.

## Response speed: indexes, caches, edge caching and real-user vitals

Migration `0038_server_speed` must be applied before this web and worker version (the Railway pre-deploy `npm run db:migrate` does it). It adds the read indexes the per-market queries need (`trade_events` by pool and slot / time, `damm_trade_events` by repository and slot, `fee_events` by repository and by pool, `damm_fee_events` and `platform_fee_events` by repository, open `graduation_alerts` by market and kind), creates `finalized_chart_positions` and fills it from the existing blocks (each indexed trade's position in its finalized block; about a second for ~1.5K blocks), and creates `web_vitals`. Everything is additive; rolling the application back leaves the new objects unused.

- **Chart ordering.** Charts and the ordering worker read trade positions from `finalized_chart_positions` instead of searching each block's full signature list (`finalized_chart_blocks` kept the complete agreed evidence, ~190 MB by October 5, and is no longer de-TOASTed on every chart request and every 30-second worker pass; lists of fully positioned blocks over seven days old are now cleared, and plain vacuum makes that space reusable while only `VACUUM FULL` returns it to disk). The worker stores positions when it records a block and fills in trades indexed after their block was recorded; until then a chart read falls back to the stored list, so results are identical.
- **Per-process caches** (per replica, like the other short read caches above): the public Explore growth surface 15 s (shared by `/explore` and `/api/growth`), built chart payloads 3 s per mint and range, dropped as soon as the market's `LISTEN` trade hint arrives, and the SOL/USD price refreshed in the background during the last minute of its 5-minute validity (an expired price is still never served).
- **Slow loader log.** Server data loaders (market list and row, chart, growth surface, trend candidates, graduation race, SOL price, token metrics, GitHub repository/release reads, launch-fee terms) are timed. One compact line `{"slowLoader":{"label":"chart","ms":412,"foldedSlow":3,"foldedMaxMs":530}}` is logged when a loader takes over 150 ms, at most once per loader per minute (`foldedSlow` counts the slow calls since the previous line). Set `SERVER_TIMING_SLOW_MS` (web) to a lower threshold temporarily when investigating. The public market APIs, `/api/growth` and `/api/repo-search` also return a `Server-Timing` header (loader names and milliseconds only), visible in browser devtools.

### Edge caching for public JSON

These GET endpoints return the same body for every visitor (they read no cookie, wallet or other header), so they carry `Cache-Control: public, max-age=0, s-maxage=N` plus `CDN-Cache-Control: max-age=N[, stale-while-revalidate=M]`. Browsers never reuse a copy (`max-age=0`, and the app's own fetches use `cache: 'no-store'`); the CDN may keep one for `N` seconds. Cloudflare disables `stale-while-revalidate` whenever `s-maxage` is present, so the CDN's stale window travels in `CDN-Cache-Control`, which Cloudflare reads ahead of `Cache-Control` and browsers ignore. Errors and wallet-specific responses stay `no-store`.

| Path | CDN copy | Notes |
| --- | --- | --- |
| `/api/market/<mint>/trades?range=…` | 2 s | A refetch prompted by a live trade hint adds `fresh=1` and is answered `no-store`, so a just-indexed trade is never hidden by an edge copy. |
| `/api/market/<mint>/curve` | 2 s | Same `fresh=1` rule. |
| `/api/market/<mint>/activity` | 5 s | |
| `/api/market/<mint>/traders` | 5 s | Linked traders' public X accounts for Recent trades; never wallet addresses. |
| `/api/market/<mint>/metrics` | 10 s, stale 20 s | `no-store` when the chain read failed. |
| `/api/repo-search` (GET) | 15 s, stale 45 s | The POST search is never cached. |
| `/api/growth` | 15 s, stale 45 s | |
| `/api/repos/<repoId>/quote-options` | 60 s | Stock pairs (docs/STOCK_QUOTES.md). Not in the Cloudflare rule below, so only the origin headers apply. |
| `/api/quote-assets/<assetId>` | 30 s | A stock pair's display multiplier and USD price for the trade panel. Not in the Cloudflare rule below. |

Cloudflare does not cache JSON unless a Cache Rule makes it eligible. In the Cloudflare dashboard (nothing here changes Cloudflare automatically):

1. Select the `repo.ing` zone → **Caching** → **Cache Rules** → **Create rule**. Name it `Public JSON APIs (origin Cache-Control)`.
2. Under **When incoming requests match**, choose **Custom filter expression** → **Edit expression** and paste:
   ```txt
   (http.request.method eq "GET" and ((starts_with(http.request.uri.path, "/api/market/") and (ends_with(http.request.uri.path, "/trades") or ends_with(http.request.uri.path, "/curve") or ends_with(http.request.uri.path, "/activity") or ends_with(http.request.uri.path, "/traders") or ends_with(http.request.uri.path, "/metrics"))) or http.request.uri.path in {"/api/repo-search" "/api/growth"}))
   ```
   This deliberately leaves out `/api/market/<mint>/events` (the live stream must never be buffered or cached), `/balance` (per wallet), `/share-card` and every other API.
3. Under **Then** → **Cache eligibility**, select **Eligible for cache**.
4. **Edge TTL**: **Use cache-control header if present, bypass cache if not**.
5. **Browser TTL**: **Respect origin**. Required: otherwise the zone's Browser Cache TTL (4 hours by default) would rewrite `max-age=0` and browsers would keep API copies for hours.
6. **Cache key**: leave the defaults, query string included (`range` and `fresh` must stay part of the key; never enable "Ignore query string"). Leave **Serve stale content while revalidating** on.
7. **Deploy**. If another Cache Rule bypasses the cache for `/api/*`, place this one after it: for each setting, the last matching rule wins.

Verify (replace `<mint>` with a live market):

```sh
U="https://repo.ing/api/market/<mint>/trades?range=all"
curl -s -D - -o /dev/null "$U" | grep -iE '^(cf-cache-status|age|cache-control|cdn-cache-control):'   # MISS, then:
curl -s -D - -o /dev/null "$U" | grep -iE '^(cf-cache-status|age|cache-control):'                     # HIT within 2 s, cache-control still max-age=0
curl -s -D - -o /dev/null "$U&fresh=1" | grep -iE '^(cf-cache-status|cache-control):'                 # BYPASS, no-store
curl -s -D - -o /dev/null "https://repo.ing/api/market/<mint>/events" --max-time 2 | grep -iE '^cf-cache-status:'  # DYNAMIC
```

Browsers must keep seeing `cache-control: public, max-age=0, s-maxage=…`; if it shows `max-age=14400`, fix step 5. To undo, disable the rule: the origin headers are harmless without it.

### Real-user Core Web Vitals

About 25% of page loads report LCP, INP, CLS, FCP and TTFB (Next.js `useReportWebVitals`, `app/components/web-vitals.jsx`) in one `navigator.sendBeacon` to `POST /api/vitals` when the page is hidden. The beacon carries only the route pattern (for example `/token/[mint]`, never the URL, query or mint) and the values; the server derives the standard rating, keeps a mobile/desktop class from a User-Agent heuristic and stores nothing else (no cookie, IP, wallet or User-Agent). Beacons are validated strictly (1 KB maximum, known routes and metrics only, bounded values) and rate-limited in `agent_request_limits` (3000 per minute overall, 30 per minute per client, keyed by a hash of the client address). Rows older than 14 days are deleted by the web service (at most once an hour per replica). CLS and INP accumulate across client-side navigations and are attributed to the route a visit landed on.

`/operations/vitals` (platform operators only, like `/operations/health`) shows the 75th percentile per route and metric for the last 24 hours and 7 days with sample counts, for all devices or mobile/desktop only.
