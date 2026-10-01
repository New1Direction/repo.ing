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

Use [encrypted backups](BACKUPS.md) for recovery. Keep recovery keys available outside the application host and verify restores into a disposable database before a cutover.

## Deploy-safe trades and the trade canary

Migration `0029_trade_sessions` stores each prepared trade (unsigned transaction, exact reviewed message, amounts, blockhash window, pool/vault/mint/referral pins, and later the first accepted signature and result) in `trade_sessions` for 10 minutes. Any web instance, including one started by a deploy, can submit and verify a trade another instance prepared; the 2-minute submit window, the reviewed-message/Lighthouse check, fee-payer and signature checks, and receipt verification are unchanged. The in-process Map is only a cache. If the database is unreachable at prepare, that session falls back to the old in-process behavior.

Zero-downtime web deploys: `GET /api/health` returns 200 once the process serves and the database answers (503 otherwise). The web service is configured in Railway settings, not a config file (Railway no longer accepts config-as-code for new setups): variables `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=30` and `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=150`, plus Settings → Deploy → Healthcheck Path `/api/health`, timeout 300. Only the web service gets the healthcheck; the worker serves no HTTP. `next start` drains in-flight requests on SIGTERM; 150 draining seconds covers the longest submit (rebroadcast, confirmation, finality wait).

The worker's trade canary runs every 5 minutes (`TRADE_CANARY_ENABLED=false` disables it): for $REPOING's DAMM market and the two most-traded active curve markets it runs the real prepare path for a 0.01 SOL buy with the team wallet as the unsigned fee payer, then only simulates — plain, and with a Phantom-style Lighthouse assertion appended, which the review check must accept and which must fit the prepared compute-unit limit. Nothing is signed or sent. Results appear under Canary on `/operations/health`; two consecutive failures of a market, or every market failing in one run, raise one `TRADE_CANARY_FAILING` alert per hour.

## Running more than one web replica

From migration `0036_launch_sessions` on, the web service is replica-safe: no request depends on reaching the replica that served an earlier request. Apply `0036` before deploying this web version (launch prepare needs the table). State that must be shared lives in PostgreSQL:

- **Launch reviews** (`launch_sessions`): `prepare` reserves and prepares the market under the repository's advisory lock and stores the review (unsigned transaction, mint, blockhash window, config, initial buy, trend revision) with a 2-minute expiry from the database clock. `submit` or `cancel` on any replica consumes it exactly once (`UPDATE … WHERE consumed_at IS NULL`), then `submit` re-checks the market under the lock and runs the same co-sign/submit/evidence path as before. The fresh mint's secret key is the only secret: it is stored AES-256-GCM sealed with a key derived from `PLATFORM_CREATOR_SECRET_KEY` (bound to the session id and mint) and erased when the review is consumed. Expired reviews are deleted, and their still-`prepared` market marked `failed`, by web requests and by every worker pass. The lock is no longer held while the wallet is open, so a second `prepare` for the same repository during an open review is refused ("awaiting wallet approval") instead of waiting. Rotating the creator key invalidates open reviews (users re-review).
- **Trades** (`trade_sessions`, above), **wallet challenges**, **holder-note / X-link / agent quotas** and the **Parts pledge prepare throttle** (`agent_request_limits`; 240/min overall, 12/min per client, 6/min per wallet) are database-backed. GitHub and X OAuth state rides in sealed cookies.
- **Live market updates** come from PostgreSQL `NOTIFY` triggers; each replica holds its own `LISTEN` connection, so every replica sees every update.

Per replica by design (correct with any number of replicas): short-TTL read caches (market list 15 s, holder counts 30 s, X handles 60 s — an unlinked handle can show on another replica for up to a minute — holder balances, repository images/logos, SOL price, release notes), the per-process concurrency caps (repo search 4, image uploads 2, 500 live-update viewers), the CSP-report limiter, and the CSP counters on `/operations/health` (they describe only the replica that served the page). If PostgreSQL is unreachable at trade prepare, that one trade falls back to in-process memory and can only be submitted on the same replica. Each replica opens its own connection pool plus one `LISTEN` connection; size `max_connections` for the replica count.

## Chart ordering verification

Graduated charts also index the verified DAMM destination's swap prices. Migration proof must bind the same repository, curve, mint, destination, slot, and receipt before DAMM history is included. Missing price or transaction-order evidence withholds affected prices while retaining verified volume. Apply migrations `0020` and `0021` before deploying this worker/web version.

Optional [builder email reminders](BUILDER_REMINDERS.md) remain disabled unless a verified sender, secret, provider key, and explicit delivery gate are configured. They do not authorize claims, trades, or reinvestment.

The worker fills `finalized_chart_blocks` for indexed slots with multiple transactions. It requires agreement from the primary and graduation-verification RPCs on mainnet genesis, finalized block identity, and the complete ordered signature list. Conflicting evidence is never overwritten. Work is capped at 12 slots per pass, with a ten-minute retry delay for unavailable slots, independently of fee indexing.

The chart joins this evidence to finalized swaps to recover candle opens and closes. Missing or disagreeing evidence keeps affected boundary-slot prices withheld; recorded volume remains unchanged. Worker logs expose `chartOrdering.verified`, `pending`, and sanitized error codes. This table does not allocate funds or enable execution.

If the verification provider has pruned an old block, keep its prices withheld. A bounded operator backfill may use another independently operated mainnet RPC with `verifyChartBlock` and `recordChartBlock`; the exact same genesis, finalized block, signature membership, and ordering checks still apply. The September 27 backfill used Solana’s public mainnet RPC to corroborate OHIYO slot `450228550`, which the normal secondary had pruned. No production RPC or financial gates were changed.

## Wallet P&L attribution

Migration `0026_trade_traders` adds nullable `trader` to `trade_events` and `damm_trade_events` plus `base_amount` on DAMM rows. The worker records the swap's signing payer, or the transaction fee payer when an aggregator routes through a non-signing authority. `/wallet` shows average-cost P&L per holding from those rows only; unexplained tokens are marked partial and never counted as profit. Rows indexed earlier stay NULL until `node scripts/backfill-trade-traders.mjs` (read-only RPC, `--dry-run` first) replays their signatures; it only fills NULL columns and refuses rows whose replayed amounts differ.

## Market display updates

Migration `0023_market_update_notifications` adds commit-time invalidation triggers to finalized indexed trade and graduation-observation tables. The web service shares one dedicated PostgreSQL `LISTEN` connection across its viewers, and `/api/market/[mint]/events` streams only public market identifiers and change types. Stream events request a fresh read through the existing canonical APIs; they never set a price, balance, fee credit, or settlement state themselves.

Streams close when the browser tab is hidden, coalesce indexing bursts, reconnect with a resync, and keep existing 15-second polling as a fallback. Each web process caps viewers at 500; an idle listener closes after 30 seconds. No worker restart is needed for the triggers. Notifications are transient, so recovery always reads durable indexed evidence. The listener never opens a database transaction; watch `pg_notification_queue_usage()` and listener connection health if investigating delayed updates. Disable the three `repoing_*_update` triggers to stop hints without removing indexed records; polling remains available.

Quotes return price estimates independently of account/network cost previews. The `costs` action is read-only and creates no signing session. The existing `prepare` action still re-quotes, checks exact funding and simulates the unsigned transaction before requesting a wallet signature. Public chart preloading is limited to two concurrent requests and 12 entries, expires after eight seconds, and always revalidates on opening a market. It never supplies trading or payout authority.

## Launch alerts

The worker can post one short message per new market to a Telegram channel and/or an X account (`src/launch-alerts.mjs`, migration `0034_launch_alerts`). A market qualifies once it is `confirmed`, indexed and `finalized`, was indexed at or after `LAUNCH_ALERTS_SINCE`, and was indexed within the last 24 hours. The text is the repository, ticker, stars, a one-line description (links, control characters and `@`/`#`/`$` prefixes removed; truncated so X posts stay within 280 characters) and the token page link. There is no market moderation flag yet, so every qualifying market is posted.

Each post is claimed in `launch_alerts` (unique per repository and channel) before it is sent, and runs hold an advisory lock, so overlapping workers or redeploys never post twice. A provider rejection (4xx, including 429, or a refused connection) is `failed` and retried after at least five minutes, up to 3 attempts. A timeout, 5xx, malformed success or a crash mid-send may have posted, so the row becomes `unknown` and is never retried automatically. Each run (about once a minute) posts at most 2 per channel, 10 seconds apart, and `LAUNCH_ALERTS_MAX_PER_DAY` (default 15) per channel per 24 hours; keep it at or below your X API tier's daily posting limit.

Setup (worker variables only; nothing posts until every step is done):

1. Telegram: create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy its token to `TELEGRAM_BOT_TOKEN`. Create the public channel, add the bot as an administrator allowed to post, and set `TELEGRAM_CHAT_ID=@channelname` (a private chat's numeric id such as `-100…` also works, but then no post links are recorded).
2. X: in the [X developer portal](https://developer.x.com), create a project and app. Under User authentication settings set App permissions to **Read and write** before generating tokens. From Keys and tokens copy the API Key and Secret to `X_BOT_API_KEY`/`X_BOT_API_SECRET`, then generate the Access Token and Secret while signed in as the posting account and copy them to `X_BOT_ACCESS_TOKEN`/`X_BOT_ACCESS_SECRET`. Tokens generated before switching to Read and write stay read-only; regenerate them. These are not the `X_CLIENT_ID`/`X_CLIENT_SECRET` used for Connect X.
3. Set `LAUNCH_ALERTS_SINCE` to the current UTC time, e.g. `2026-10-01T00:00:00Z`, so existing markets are never announced, then set `LAUNCH_ALERTS_ENABLED=true`. A channel with only some of its variables, or a missing/invalid cutoff, logs `launchAlertError` once at startup and posts nothing.

Verify: the worker logs `{"launchAlerts":{"posts":[…]}}` only when it posts (status `sent` with the post URL, `failed` with the provider error, or `unknown`); it is silent otherwise. Check rows with `select channel, status, attempts, message_url, error, created_at from launch_alerts order by id desc limit 20`. For an `unknown` row, look at the channel: if the post is missing and should go out, delete the row to allow one new attempt; if it posted, leave the row. Setting `LAUNCH_ALERTS_ENABLED=false` stops new posts immediately on the next worker restart.

## Do-not-promote list

`PROMOTION_EXCLUDED_REPO_IDS` (web and worker) is a comma-separated list of GitHub repository IDs that repo.ing must never promote: they are hidden from `/waiting` (no "Tag them on X" prompt) and must be skipped by any feature that features or announces markets. Their markets and builder fees are unaffected. Use it when a maintainer asks not to be contacted or promoted, or when promoting a repository would be inappropriate.
