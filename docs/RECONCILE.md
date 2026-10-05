# RECONCILE transition

> **Since this report:** reconciliation sums `builder_fee_credits` (`fee_events` plus graduated `damm_fee_events`), compares the unpaid remainder with the pool's `creatorQuoteFee` plus, after graduation, the creator position's unclaimed DAMM fees, and also checks the partner's fee capture and the graduated withdrawals (`src/reconcile.mjs`, [Graduated fees](GRADUATED_FEES.md)).

The focused local-validator run passed on 2026-09-24 using `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13`. `src/reconcile.mjs` reads the indexed canonical market, sums append-only `fee_events` and settled `repo_claims` for its immutable GitHub repository ID, and compares their difference to the finalized DBC pool's `creatorQuoteFee`. All amounts below are integer lamports of the SOL quote asset. The reported difference is **on-chain creator fee minus expected remaining**.

| Evidence | Value |
| --- | --- |
| Network | local `solana-test-validator`, `http://127.0.0.1:8899` |
| Repository | `New1Direction/Waternot`, immutable ID `1384142609` (local fixture) |
| DBC config | `HB1EckDa3wQ1k91aFD6szdRnGDDXW6oNMZs6BMxqF1nG` |
| SPL mint | `CpwBa55ozhVrpZqXXgov86a4dUWrGEZ1fHYFTG2uvZX6` |
| Canonical pool | `FHnjD4HzNC74fuQJkEXhPYQfKeZ6TjhVW2TWoSCJV7RC` |
| First trade | `3vBozs2aezUmUNLxFYBuJg8iMMKemMQte6FXASH8ADVMhftDrgVjo9gq3DcCibakwJfpkJew4jJcJZnboZght1ha` |
| Settled claim | `3KgnAvj46r6Rc8XLL3qdHKSeUGChCqcBKqDi6MYJ9w6GyMdx3HMCcVJVUXx8qpKEENg5qHpu76RRR3jPKgUUWTGa` |
| Later trade | `5pjwacGY28j7wjQjSsY53q9k9Rs4UEUh8f7L9wbv6Y8c9y5wyvaBYZjWtaFnZRBUkvR2XnJ2XziGuVRPLW9SrYD2` |

| Stage | Recorded earned | Settled claimed | Expected remaining | On-chain creator fee | Status | Difference |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| First trade indexed, no claim | 40,000 | 0 | 40,000 | 40,000 | `MATCH` | 0 |
| Claim settled | 40,000 | 40,000 | 0 | 0 | `MATCH` | 0 |
| Later trade indexed | 60,000 | 40,000 | 20,000 | 20,000 | `MATCH` | 0 |
| Controlled one-lamport ledger discrepancy | 60,001 | 40,000 | 20,001 | 20,000 | `MISMATCH` | −1 |

The mismatch test inserted one synthetic fee event into its disposable database, then checked that the event and settled claim rows remained untouched. The function did not repair either side. A synthetic unresolved `pending` claim then returned `PENDING_REVIEW`, with no interpreted on-chain amount or difference. If the required Meteora pool state cannot be read or does not match the canonical pool's mint, config, and creator, the function returns `UNAVAILABLE`; that branch was not separately exercised in this narrow run.

## Restart and reproduction

The test started a second Node process after the later trade. It read the persisted fee events and claim from PostgreSQL, read the finalized pool state, and returned the **same** `MATCH` result: earned `60,000`, claimed `40,000`, remaining and on-chain `20,000`, difference `0`.

Use the existing DBC and Metaplex local-validator fixtures described in `docs/LAUNCH_COORDINATOR.md`, a dedicated local test database, and run:

```bash
export DATABASE_URL=postgres://postgres:launchtest@127.0.0.1:55432/gitfun_reconcile
npm run db:migrate
npm run test:reconcile
```

For a read-only result from a new process while that validator state is available:

```bash
npm run reconcile:repo -- 1384142609 HB1EckDa3wQ1k91aFD6szdRnGDDXW6oNMZs6BMxqF1nG
```

After the complete test, its deliberate pending-claim fixture remains in the disposable database, so this command returns `PENDING_REVIEW`. The restart assertion runs earlier, immediately after the later trade, when it returns `MATCH`.

Changed: `src/reconcile.mjs`, `scripts/reconcile-repo.mjs`, `tests/reconcile.test.mjs`, `package.json`, and this report. **No schema change** or balance cache was added. The focused run passed **5/5 tests**: no-claim match, settled-claim match, later-trade match plus restart, controlled mismatch, and pending review. It used disposable local keys and no live funds. DAMM v2 post-migration fee state and a concurrent trade during a reconciliation read remain unverified; neither was needed for this DBC transition.
