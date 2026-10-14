# Backend latency and reliability budgets

These budgets cover shared web/worker infrastructure, not guided launch or its preflight. They are local regression
targets and operational thresholds, not promises about mainnet latency or investment outcomes.

## Transport limits apply before a caller can stall the worker

`src/rpc-usage.mjs` applies the same limits to all connections using a meter's provider label:

| Resource | Budget | On exhaustion |
| --- | --- | --- |
| HTTP request, including queue, backoff and response body | 15 seconds | Abort the actual fetch; surface `TimeoutError` |
| Concurrent requests per provider/process | 8 | FIFO queue |
| Queued requests per provider/process | 64 | `RPC_RATE_LIMITED`, without sending |
| Slow request threshold, including waits | 3 seconds | `RPC_SLOW` in the next usage report |
| Provider backoff | Existing jittered exponential policy; at most 5 minutes | Wait up to 10 seconds, otherwise refuse locally |

There are **no transport retries**, including for sends. Existing read-only retry callers retain their attempt bounds
(normally four attempts in `retryRpcRead`; raw finalized transaction reads allow five HTTP 429 attempts with at most
10 seconds between them). Those loops, and sequential verification-provider failover, can exceed the single-attempt
15-second deadline. This is not a whole-job deadline. Never treat an ambiguous broadcast timeout as proof it failed:
existing signed-intent recovery and finalized evidence remain authoritative.

The meter buffers the JSON-RPC body before releasing its concurrency permit. Fetch resolving at headers alone is not
completion: a provider can stall the body too. Caller cancellation is retained, including while queued or backing off.
There is no queue or response sharing across provider labels; replicas have their own limits.

## Only immutable finalized evidence is shared

Concurrent reads of the same finalized signature at the same endpoint join one request. Complete answers with a block
time retain the existing 500-entry cache. Errors, missing transactions and incomplete answers are not retained; a later
call retries them. Confirmed reads and injected transports always read independently. Each verification provider answers
for itself. Invalidation during an outstanding read prevents its late answer from refilling the cache.

No GitHub authority, account balance, quote, wallet permission, risk disclosure or mutable chain state gains a cache.
Existing GitHub installation-token reuse and repository polling schedules remain unchanged.

## Index the scheduler's latest-session lookup

Migration `0075_worker_session_lookup` adds `(github_repo_id, submitted_at) WHERE submitted_at IS NOT NULL` to
`trade_sessions`. Both SOL and stock fee schedulers use the existing correlated `MAX(submitted_at)` query unchanged.
PostgreSQL can take the newest index entry instead of scanning every session once per market. Repositories without a
submitted session still return null. The index excludes unsigned/unsubmitted sessions and contains no transaction body.

Deploy through the normal additive migration process, after `0074`. No shared/production migration is run by the
benchmark. Plain `CREATE INDEX` briefly blocks writes to this normally ten-minute-lived table: inspect its size and
schedule the migration appropriately if cleanup has fallen behind. Code correctness does not depend on the index.

## Alert on errors and slow requests without logging credentials

Existing minute-level `rpcUsage` reports now include per-provider `latency` counters: `completed`, `errors`, `timeouts`,
`overBudget`, `totalMs`, and `maxMs`. `alerts` contains `RPC_ERRORS` and/or `RPC_SLOW` when a window has failures or requests
over three seconds. Completion counters are recorded in the window where the request finishes; call/credit counts are
recorded when it starts. HTTP errors, queue/backoff refusals, cancellation and transport failures count as errors; a
JSON-RPC application error in a successful HTTP response is still handled by the caller, not classified by this meter.

Logs contain provider labels, counts and durations, not endpoint URLs, headers, signatures, wallet addresses, bodies or
error messages. Reports are passive signals for the existing log sink, not a newly configured pager/webhook. Investigate
repeated errors or sustained slow windows; do not trigger signing, retries of broadcasts, or deployments from them.
Worker heartbeat/stage freshness reporting belongs to the separately maintained reliability dashboard.

## Reproduce the measurements

Node 22.23.3, PostgreSQL 15.19 and Solana validator 4.0.1 in an orb, 2026-10-14. Medians use seven runs. The HTTP fixture
models congestion (10ms + 5ms per active request); it is not a measurement of Helius or mainnet.

| Scenario | Before | After | Evidence |
| --- | --- | --- | --- |
| 24 concurrent cold-cache reads of one finalized signature | 24 requests; 136.83ms | 1 request; 17.64ms | Real local HTTP transport and production transaction loader |
| Scheduler lookup: 200 markets, 20,000 wide sessions | 124.88ms | 1.18ms | Same SQL/results, before/after index in one PostgreSQL session; EXPLAIN ANALYZE uses index-only scans |
| Built activity API control, seeded SOL market with six events | Not compared | 7.97ms median, 12.68ms p95 warm; 193.83ms cold | Real Next production build + PostgreSQL, 1 cold and 20 warm requests |

The API control's final `Server-Timing` was `market;dur=2.8, total;dur=3.7`. It is a regression control, not a claim that
the activity endpoint was optimized. Database/index fixtures assert identical results, including null-only and absent
repositories. Tests additionally exercise stalled headers/bodies, recovery, overflow, queued cancellation, independent
providers, backoff after queueing, invalidation, and chain fee replay without duplicate credits.

```sh
node scripts/benchmark-backend.mjs --check

# A disposable local database; the benchmark creates only temporary tables.
createdb -h 127.0.0.1 -p 55432 -U postgres repoing_perf_test
BENCH_DATABASE_URL=postgres://postgres@127.0.0.1:55432/repoing_perf_test \
  node scripts/benchmark-backend.mjs --check

# Optional: point a running production build at the local external-fee-indexer test database.
# The market must contain activity (an empty or error response fails the benchmark).
BENCH_HTTP_ORIGIN=http://127.0.0.1:3001 BENCH_MINT=<seeded-mint> \
  node scripts/benchmark-backend.mjs --check
```

`--check` requires one request per same-signature burst, median burst latency below 250ms, indexed query median below
50ms and optional warm activity API p95 below 250ms. Run on an otherwise idle machine. It is opt-in, not a timing gate
in the quick suite. Each run prints JSON measurements; PostgreSQL output includes the full execution plan.

```sh
node scripts/ci/run-quick-tests.mjs
npm run build
# After starting the disposable PostgreSQL and validator services described in DEVELOPMENT.md:
node scripts/ci/run-tests.mjs server-speed-db database-pool trade-sessions external-fee-indexer fee-accrual trade launch-chain
```

These measurements do not establish production throughput, whole-worker pass latency or production endpoint p95.
Use existing `Server-Timing`/`slowLoader` and the new RPC counters to compare those after an independently authorized
deployment. Public APIs, signature validation, finality requirements and two-provider agreement are unchanged.
