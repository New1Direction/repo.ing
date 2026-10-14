# Operator reliability

Open `/operations/reliability` (linked from Operations health). The read-only JSON equivalent is
`GET /api/operations/reliability`. Both use the existing encrypted GitHub builder session and
`PLATFORM_OPERATOR_GITHUB_IDS` allowlist. Repository admin rights alone are insufficient. Anonymous/expired
sessions get 401 from the API; signed-in nonoperators get 403. Every API response is `private, no-store`.
There is no write/retry/acknowledge endpoint, public monitoring token, automatic polling, or new alert sender.

## Rollout and version visibility

Apply migration **0074_operator_reliability** through the usual approved migration workflow, then deploy the
web and worker builds. Do not run migrations from the dashboard. The migration creates one snapshot row's
table and a partial index for failed webhook deliveries. Index creation can hold a write lock; allow a maintenance
window on a large delivery table. Lock acquisition times out after 5 seconds. Missing migration reads as unknown;
worker telemetry write failures do not stop work. No backfill is required.

Set `REPOING_COMMIT_SHA` to the deployed Git commit on both web and worker, or use the existing
`RAILWAY_GIT_COMMIT_SHA` / `VERCEL_GIT_COMMIT_SHA`. Only 7–40 hex characters are displayed. Missing metadata
is unknown; a differing worker/web commit is called out, not proof of a bad deployment.

## What the evidence means

* Worker: every 60 seconds, the existing metered `runOnce` jobs publish their latest start, completion,
  last success and duration in a single overwritten row. A fresh heartbeat is not evidence of forward progress:
  a running stage older than the runtime threshold needs attention. Recognized returned failures/reviews are
  degraded; skipped/deferred work is incomplete. Completed includes an empty batch and means no recognized
  error, **not** that every market succeeded. Last success is process-local and resets on worker restart.
  Optional/not-yet-run jobs are absent; live subscriptions and jobs outside that wrapper are not covered.
  With multiple worker processes the last writer wins: this is **not fleet health**. Consult per-process logs.
* Reports: latest stored assessment per finalized, indexed SOL market. Missing, older than threshold, future-dated,
  or assessed at/before market indexing needs attention. Liquidity freshness uses the latest persisted sample,
  not last trade time; an illiquid but correctly observed market is not an indexer outage.
* Markets: inspect the first 1,000 eligible markets by id. A 1,001st row marks truncated coverage; unseen markets
  remain unknown even if the sample has no stale rows. No scans of report payloads or trade history.
* Pending launches: oldest 1,000 prepared/submitted/ambiguous markets; age is since creation, not last retry.
* Webhooks: oldest 1,000 pending/sending deliveries by next attempt. Retry backoff is not overdue until its next
  attempt exceeds the threshold. Failures are capped at 1,000 among deliveries **created** in the last 24 hours,
  not failed in the last 24 hours (failure time is not stored). Includes inactive/deleted-subscription failures.
  `1000+` means a lower bound, not an exact total. Unfanned-out events and other notification channels are not covered.
* Database/RPC: one `SELECT 1` and one confirmed `getSlot` probe. These establish reachability/latency from the web
  service, not replication, writes, chain freshness, provider failover or transaction landing.

## Threshold configuration and alert routing

Set these on the **web service**; milliseconds, integer range 1,000–604,800,000. Invalid values use defaults.
The active values are displayed and returned in JSON. Comparisons are strictly greater than the threshold.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `OPS_WORKER_STALE_MS` | 180000 | Age of persisted worker snapshot |
| `OPS_STAGE_SLOW_MS` | 300000 | Last stage duration or currently running duration |
| `OPS_REPORT_STALE_MS` | 7200000 | Stored report age (worker targets hourly) |
| `OPS_MARKET_STALE_MS` | 7200000 | Latest liquidity sample age (worker targets hourly) |
| `OPS_PENDING_STALE_MS` | 900000 | Pending launch age or webhook overdue duration |
| `OPS_DEPENDENCY_SLOW_MS` | 1000 | Database/RPC read probe latency |

Any missing report/sample, recent failed delivery, retrying delivery, stage failure/deferral, or capped queue also
needs attention. Unknown is never converted into OK or zero. `status` is `degraded` if any observed warning exists,
otherwise `unknown` if any section is unknown, otherwise `ok`; always inspect each section. HTTP 200 means the
snapshot was delivered, **not** that health is OK. Alert on repeated degraded/unknown observations, not HTTP alone;
use at least two snapshots more than 30 seconds apart to avoid paging on the same cached evidence. Integrate through
an already authorized operator session; no long-lived credential or automatic notification is introduced here.
Existing business alerts remain in `/operations/health` and the existing alert channels.

For stale workers check process logs, database access and clocks. For stale reports check `transparency` stage logs,
`MARKET_TRANSPARENCY_SAMPLING`, RPC throttling, item timeouts and backlog. For webhook issues check
`LAUNCH_WEBHOOKS_ENABLED`, worker signing-key configuration, receiver availability and disabled subscriptions;
never expose receiver URLs or keys in alerts. For ambiguous launches inspect chain evidence before retrying.

## Cost and privacy

Snapshots are single-flight cached for 30 seconds per web process, including partial failures. Six bounded
database queries use a separate maximum-three-connection read-only pool: 1s connection wait, 2s server statement
timeout, 2.5s client query timeout. Each list returns at most 1,001 scalar rows; market sample lookups use the
existing `(github_repo_id, sampled_at)` index. Sorting/filtering can still examine more rows, so server deadlines
are mandatory. RPC has a 2.5s abort deadline, no retries and no endpoint parameter. Worker writes coalesce on a
separate maximum-one-connection pool (1s connection, 1.5s statement, 2s query deadlines) and never block jobs.
No wallets, user IDs, repositories, transaction payloads, webhook destinations, provider URLs or raw errors are
returned. Fixed stage names are the only job dimension. No history is retained.

## Validation

`node --test tests/operator-reliability.test.mjs tests/operations-health.test.mjs tests/migration-journal.test.mjs`
checks classification, strict thresholds, partial failures, sanitized output and API denial. The reliability test
in `tests/launch-transparency-db.test.mjs` exercises real migrated PostgreSQL via its existing disposable database
guard. `npm run build` checks the production routes; inspect authorized, unauthorized, unknown and degraded UI at
desktop and narrow widths before shipping.
