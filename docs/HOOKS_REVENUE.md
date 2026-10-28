# Hooks revenue ledger and collection plans — 2026-10-28

[Documentation](README.md) / Hooks revenue

**Status: read only. Nothing here signs, sends or moves funds.** The report reads the chain and prints JSON. The collection plan is unsigned.

[Platform revenue](PLATFORM_REVENUE.md) covers repo.ing's DBC and DAMM v2 partner fees. This covers the other source: coins launched on our own Hooks stack (launch `9zzzPsLU…`, swap `72tDzM3m…`). repo.ing earns two things there:

- **The launch fee:** 0.05 SOL, paid by the creator to the treasury in the launch transaction (`LaunchCreated.launch_fee_lamports`).
- **The trade share:** 25% of every creator fee. It is held in the pool's `protocol_fees_quote` until `collect_protocol_fees_native` pays the whole amount to the pool policy's collector (the treasury). Anyone may send that instruction. The sender pays only the network fee.

## Ledger (`src/hooklab-revenue-ledger.mjs`)

For each market, the report reads the pool's and the launch account's finalized histories and decodes four events, each authenticated as the program's own `emit_cpi` (`src/hooklab-revenue-events.mjs`):

- `LaunchCreated` (launch fee);
- `InclusiveCreatorFeeAccrued` (each trade's protocol and creator shares);
- `ProtocolFeesCollected`;
- `CreatorFeesClaimedSol`.

Every entry names its transaction and event. The chain keeps two running counters, and the ledger checks every step against them:

- **The pool's `protocol_fees_quote`:** each accrual reports the counter after adding its share. Each collection must pay out exactly what was pending, to the expected collector, and the collector must receive it. At the end, the pool must hold what its history adds up to.
- **The launch's `claimed_total`:** each claim must add exactly what it paid, to the launch's creator, and the creator must receive it. Claims can never exceed what accrued. Above its rent, the launch account must hold what the creator is still owed.

Each failed check is a finding with a code, for example `PROTOCOL_CHAIN_GAP`, `UNEXPECTED_COLLECTOR`, `COLLECTION_NOT_RECEIVED`, `CREATOR_CLAIM_GAP`, `CREATOR_OVERPAID` or `LAUNCH_FEE_NOT_RECEIVED`. A market with an error finding does not reconcile.

`reconcilePayments` compares our own payment records with the chain. It reports records with no matching payment, payments with no record, records listed twice, and amounts that differ.

## Collection plan (`src/hooklab-collection-plan.mjs`)

A plan lists the pools to collect, largest first, with the exact amount each must pay. A pool is left out, with the reason given, when:

- its market does not reconcile;
- it is below the 0.0005 SOL threshold (500,000 lamports, about 100 times a collection's network fee);
- it was collected within the last 20 hours (the cooldown);
- it is above the 5 SOL review cap;
- the run's network-fee budget is used up;
- it is not an inclusive (fee model 2) pool.

The plan id is a hash of the state it was made from, so the same state always gives the same plan. An executor sends an item only while `itemStillValid`, meaning the pool still holds exactly the planned amount for the planned collector. `scripts/hooks-fee-collector.mjs` is the executor. It is installed with an unfunded cranker key that has no authority over funds.

## Not part of the platform revenue policy

Hooks revenue is tracked and reconciled here only. It does not enter the 60/20/20 platform revenue policy, which covers claimed DBC and DAMM v2 partner fees ([Platform revenue](PLATFORM_REVENUE.md)). Hooks coins keep the inclusive 75/25 creator/repo.ing split of the creator fee, and the 0.05 SOL launch fee goes to the treasury (owner decision, 2026-10-28).

## Run it

```bash
node scripts/hooks-revenue-report.mjs                      # live, read only (SOLANA_RPC_URL or the public mainnet RPC)
node scripts/hooks-revenue-report.mjs --rpc-file FILE      # the RPC URL from a file (never printed)
node scripts/hooks-revenue-report.mjs --recording tests/fixtures/hooklab-revenue-mainnet.json   # replay, no network
node scripts/hooks-revenue-report.mjs --records records.json                                    # also reconcile our records
```

It exits 1 when any market does not reconcile. The replay fixture holds both coins' full mainnet history as of 2026-10-28. Both reconcile to the lamport:

- launch fees: 100,000,000 lamports;
- trade share pending: 213,126 lamports (49,750 + 163,376);
- creator fees: 639,386 lamports accrued, all claimed.

## From Pump.fun's fee program

These are ideas only, checked against [lalalune/pumpfun-source](https://github.com/lalalune/pumpfun-source) (`programs/pump-fees/src/state.rs`, `buyback.rs`, `withdrawal.rs`). No code was copied. The repository is MIT, but it reconstructs another party's program.

- **Running totals beside every payout** (`BuybackVault.total_claimed`, `SocialFeePda.total_claimed`): our programs already keep them (`protocol_fees_quote`, `claimed_total`). The ledger now uses them to prove that no payment was skipped or doubled.
- **A claim rate limit** (`claim_rate_limit`, `last_claimed`): this became the collection cooldown.
- **Sweeps keep rent** (`minimum_balance` before transfer): the creator-holding check compares only the lamports above rent.
