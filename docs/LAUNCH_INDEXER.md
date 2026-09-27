# Confirmed launch indexing

Run date: 2026-09-24. Scope: `INDEX` only, using the existing coordinator and local Meteora validator fixture.

## What changed

Migration `drizzle/0001_violet_sister_grimm.sql` adds four nullable fields to `markets`: `launch_slot`, `launch_finality`, `indexed_at`, and `last_verified_at`. A check constraint requires a slot, `finalized` finality, and verification time whenever `indexed_at` is set. No new table was needed. `src/launch-evidence.mjs` verifies chain evidence; `src/launch-indexer.mjs` reconciles and updates the existing market row; `scripts/index-launches.mjs` runs one pass as a separate process.

The verifier uses Solana [`getTransaction`](https://solana.com/docs/rpc/http/gettransaction) at `finalized` commitment to obtain the launch slot and inspect the actual instruction. It requires Meteora DBC's `initializeVirtualPoolWithSplToken` discriminator and the recorded config, creator, mint, pool, and payer in their SDK 1.5.13 account positions, with the creator, mint, and payer among the transaction signers. It independently derives the DBC pool address and reads the finalized DBC pool and SPL mint accounts. It checks the pool's config, creator, and base mint and the mint's SPL Token program owner. A database row alone is never accepted as proof.

The worker loads `confirmed`, `submitted`, and `ambiguous` rows. It takes the same repository advisory lock as the coordinator. A matching finalized launch gets its first `indexed_at` and slot; a repeated pass preserves `indexed_at` and updates `last_verified_at`. An incomplete submission is promoted only if its recorded signature and accounts verify. It reports `incomplete`, `invalid`, `missing`, `mismatch`, or `unavailable` when evidence does not match or cannot be obtained. It does not rewrite contradictory mint, pool, signature, or slot values.

## Local evidence

| Item | Value |
| --- | --- |
| Network | Local validator, DBC SDK fixture, finalized commitment |
| Repository ID | `1296269` |
| DBC config | `6jWfJpPMxjR1fhPijsjtw5r6B3qtS5WZPHRzy6DcFgHn` |
| Launch signature | `3kcFC5pRwjcdAEJ49zy7wFRcQ2boycXf1uRz8ucjmnara6LcmVA4gvuo55w4qFYBdALcgJPcJUZ6eStekX12XriZ` |
| SPL mint | `8FyGopHqQoxX7JUNujzo2pjKpahuChTpUgZCeWvQMmG2` |
| DBC pool | `HWve1dTU7Bc7zb3KvbdK6QsVd6P4wmrKKWax9XnwWDjA` |
| Finalized launch slot | `1301` |

`npm run test:index` passed. It launched the token through the existing coordinator, waited for finalized chain evidence, then ran the worker in one child process (`indexed`) and again in a new child process (`verified`). Both returned market ID `1`, the same mint/pool/signature/slot, and one database row. The original `indexed_at` was unchanged after restart. Reconciliation returned `match`.

The same test changed database mint, pool, and signature values in turn. The worker reported `mismatch`, `mismatch`, and `invalid` without repairing them. A different valid transaction signature was rejected because it was not the recorded DBC pool creation. A missing signature returned `incomplete`. An `ambiguous` row with no signature was not promoted. Restoring the actual launch signature allowed the worker to recover that row to `confirmed` and reconcile it at the original slot, again with one row. This ambiguous case was simulated after a successful launch; an actual RPC timeout followed by later discovery was not induced.

The existing launch tests also passed after the migration: `npm run test:launch` (7 tests) and `npm run test:launch:chain` (1 real DBC launch). The index test passed 1 integration test with the assertions above. All commands exited 0.

A separate `index:once` run against the retained market returned `verified` at slot `1301`. Supplying a different local test config address returned `mismatch` and did not change the market.

## Reproduce

Start local PostgreSQL and the Meteora validator as described in `docs/LAUNCH_COORDINATOR.md`, apply migrations with `npm run db:migrate`, then run `npm run test:index`. The test uses a dedicated database: it truncates the test tables before launching and generates local keypairs in memory. A new run gets different addresses and a different slot.

To run the worker against a retained local test database:

```bash
DATABASE_URL=postgres://postgres:launchtest@127.0.0.1:55432/gitfun_launch \
SOLANA_RPC_URL=http://127.0.0.1:8899 \
DBC_CONFIG=<config-from-that-test-run> \
npm run index:once
```

The worker is one-shot; run the same command again to repeat verification. It requires an RPC with finalized transaction history. If history is missing or the RPC is temporarily unavailable, it returns `unavailable` and leaves the row unchanged. Devnet and a production worker deployment remain unverified.
