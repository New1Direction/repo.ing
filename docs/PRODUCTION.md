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
