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
