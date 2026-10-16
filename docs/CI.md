# Integration CI

`test.yml` runs every `tests/*.test.mjs` on pull requests and pushes to main. The quick check and build are unchanged.
The integration matrix partitions the existing environment groups, **not individual test cases**:

| Shard | Groups | Baseline test time |
| --- | --- | ---: |
| `default` | The entire default group, including shared scratch databases and opt-in PostgreSQL cases | 32m13s |
| `primary` | Other pinned database/environment groups | ~30m |
| `stock` | All pinned `stock-*` groups, including four stock-validator suites | ~14m |
| `isolated` | Bundle and early-access chain groups, with their own validator flavors | ~11m |

Baseline: [green run 38920691711](https://github.com/new1direction/repo.ing/actions/runs/38920691711), October 16, 2026,
Node 22 / PostgreSQL 17 / Solana 4.0.1 on `ubuntu-latest`. The integration job took **88m01s**, including **86m58s** in the
test step (2,506 passing, one skipped). Group timings above come from timestamped group boundaries; the default group's
Node reporter measured 1,931.7 seconds. Setup was not the bottleneck: cached npm installation took 17s, Solana cache
restore 5s, fixture restore 1s, and validator startup 15s. Compare completed job timestamps, not aggregate runner-minutes,
when measuring wall-clock improvement. Runner queue time and live mainnet reads introduce variability.

## Isolation and coverage

Each shard runs on a **separate GitHub-hosted runner** with its own PostgreSQL service, ports, filesystem and fresh ledgers.
Do not run shards concurrently on one host. Tests truncate shared tables, create/drop fixed database names, use pinned
ports and deploy/mutate validator accounts. `--test-concurrency=1`, environment variables, database guards, migrations,
test assertions and within-group order are unchanged. Default and primary may use the same database names only because
their servers are separate. `builder-allocation`/`graduated-fees` and `hf-launch-db`/`hf-launch-chain` stay together.
Every new file still enters the full suite automatically; unpinned files enter `default`.

`tests/ci-shards.test.mjs` checks that the union contains every file exactly once and that the original groups, environment
and order survive intact. Matrix fail-fast is off so one failure cannot hide other shards. The original full-suite check
name aggregates all shards and fails on failed, cancelled or skipped integration jobs. Branch protection is not changed.

## Serial backstop and profiling

The nightly run (08:23 UTC) and manual `workflow_dispatch` run **the entire suite in the original serial order** on one
runner. The serial timeout is 120 minutes (the baseline was already close to the old 90-minute cap). Failures on scheduled
main runs open an issue, as push failures already did. Schedules take effect only after merge. To run the backstop on a
specific branch, use `gh workflow run test.yml --ref <branch>` and verify the run's `headSha` before interpreting results.

Local commands (from the repository root):

```sh
node scripts/ci/run-tests.mjs --list                    # Original serial plan; no services touched
node scripts/ci/run-tests.mjs --shard=stock --list      # Inspect one shard
node --test tests/ci-shards.test.mjs                    # Partition/selection contract
node scripts/ci/run-tests.mjs                          # Full original serial suite, services required
CI_TEST_REPORT_DIR=/tmp/test-reports node scripts/ci/run-tests.mjs --shard=primary
```

Each CI job uploads `test-reports-<shard>` for 14 days: per-group TAP plus `timings.json` with setup/test durations,
file membership, exit status and counters. Timings persist after each finished group, including prior groups on failure.
Use these to rebalance **whole** groups if durations drift; do not remove slow tests or shorten their timeouts.

## Cache policy and limits

Existing npm, version-keyed Solana CLI and script-keyed historical Meteora fixture caches remain unchanged. No database
template, ledger snapshot or live-mainnet program cache is added. Replaying migrations and constructing fresh chain state
are part of what this suite verifies. Stock/early-access/bundle scripts retain their live program reads, and the bundle's
historical DBC checksum remains enforced. Faster wall time costs extra runner setup and one serial suite per night.
Cross-group ordering bugs can now surface only in that serial backstop; mainnet availability/drift and runner contention
remain external sources of failures. Hook Lab production gates, application code, deployment, signing, trading and shared
migrations are outside this change.
