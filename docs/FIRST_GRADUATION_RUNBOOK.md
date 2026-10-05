# P5: first real graduation

[Documentation](README.md) / [P3 bounded execution](P3_FIRST_LIVE_RUNBOOK.md)

**Manual operations only. P3 and P4 remain OFF throughout readiness work.** A market reaching its target is not yet proof of graduation. Do not create volume to advance it, wash trade, run a trading bot, or add token incentives. Observe real activity. This runbook does not itself authorize a new trade, fee claim, migration fallback, or liquidity transaction.

## 1. Detect

Open `/operations/graduation` with a builders-scoped GitHub session for an immutable ID in `PLATFORM_OPERATOR_GITHUB_IDS`. Public visitors and ordinary builders cannot read its API or acknowledge alerts.

The worker compares finalized DBC pool/config account bytes across the primary RPC and `GRADUATION_VERIFICATION_RPC_URL`. It reads `quoteReserve / migrationQuoteThreshold` from the actual approved config for that market. A reserve is not cumulative trading volume. Sells can reduce progress. Original markets retain their original config/target.

- `CURVE`: target not reached, or target reached while migration is pending.
- `GRADUATED`: canonical migration transaction, DAMM pool and original creator/partner positions verified.
- `REVIEW` or stale: stop; no assumed phase or readiness.

Observe the operator `GRADUATED` alert. Record immutable repo ID, mint, DBC pool and approved config. Read `graduation_events` for that repo. Capture its signature, slot, timestamp, evidence hash and reconciliation-at-detection. Repeated indexing must retain exactly the same event.

## 2. Verify migration evidence

Require both RPCs to agree on finalized success, instruction ordering and transaction balances. `migrationPosition` must identify the actual DBC migration instruction naming the exact curve/config, mint/SOL pair, DAMM program and derived pool. A matching mint pair alone is insufficient.

The event stores transaction pre/post native and token balances, both position account proofs and the post-migration curve account. `previous_observation` is the last observed finalized state, **not a claimed exact historical pre-instruction account dump**. If the worker first saw the market after graduation, that observation may be absent; transaction pre/post balances remain mandatory. Preserve slot and signature as chain ordering evidence. Within-transaction instruction ordering is retained by its message hash and migration receipt verification; block time is descriptive, not an ordering key.

If the migrator has not completed, leave the market `CURVE / migration pending`. Inspect the external migrator and funding conditions; never mark it graduated by updating the database. Any manual migration fallback needs a separately reviewed transaction.

## 3. Verify both original positions

Use the existing graduated-fee verifier on both providers:

- Enabled canonical DAMM pool; exact repository mint and native SOL; SOL-only fee collection.
- Original creator and partner positions from the migration, owned by the DAMM program.
- Position NFTs: correct mint, one token, no delegate, creator wallet and config fee-claimer ownership respectively.
- Expected permanently locked creator/partner liquidity; no unexpected unlocked or vested allocation.

An extra position is not a substitute for either original migration position. Missing or mismatched evidence is a stop condition.

## 4. Observe initial DAMM fee accrual

Wait for genuine user swaps. P5 never generates trading activity. If an operator later requests a bounded real rehearsal trade, review its exact amount and wallet approval separately; do not perform a round trip merely to generate volume.

The existing fee worker appends `damm_fee_events` and `platform_fee_events` from verified position fee-growth checkpoints. P5 additionally indexes actual finalized DAMM swap CPIs into `damm_trade_events`, maintaining the existing cursor mechanism under the DAMM pool address. Deposits, migrations and fee claims are not swaps. Missing history prevents a verified volume display.

Observe `PARTNER_FEES_FIRST_ACCRUED`, then `PLATFORM_CLAIM_AVAILABLE`. Earned fees are not spendable platform revenue until a claim has settled.

## 5. Reconcile platform fees

Require all three checks to return `MATCH`:

1. Selected repository `createReconciler(...).reconcile(repoId)`, including creator and partner checkpoints versus indexed earnings and settled payouts.
2. `reconcilePlatformRevenue(db)`.
3. `reconcileLiquidity(db)`.

No unresolved claim or liquidity submission, negative reserve, missing history or unexplained external withdrawal may remain. Let normal indexing catch up; preserve and investigate persistent discrepancies. Never edit balances to obtain `MATCH`.

## 6. Review and claim eligible platform fees

In the authenticated operator browser, `GET /api/platform-fees/{repoId}` returns the indexed amount, on-chain available amount, latest intent and an expiring review. Check that amounts agree, are positive, no claim is pending, and the destination is the protected partner wallet. Then explicitly approve that exact claim and `POST` its returned `{ "review": "…" }` to the same endpoint.

Capture the finalized signature, exact claimed amount, partner claim checkpoint increase, and wallet delta with network/account costs identified. For a timeout, inspect the same durable claim; do not create a replacement. Refresh fee indexing and require repository reconciliation `MATCH` again.

## 7. Allocate under V1

`GET /api/platform-revenue` must show active policy **version 1: 60% buyback reserve / 20% liquidity / 20% treasury** and a positive unallocated settled claim. Review the returned allocation token. Explicitly `POST { "action": "allocate", "review": "…" }` to that endpoint.

Record the allocation group, funding claim signature, integer allocation amounts and policy version. Claims must be allocated once; parts must sum to the original claim. This action creates accounting allocations, not trades or token buybacks. Buybacks remain disabled.

## 8. Confirm the reserve

Read `/operations/graduation` again. Require a non-zero verified liquidity reserve after existing commitments. For the full 0.05 SOL investment, V1 needs at least **0.25 SOL eligible claimed and allocated revenue**. A smaller reviewed investment may use a smaller reserve.

Require separate operating SOL for at most **0.012 SOL** account/network overhead while preserving the remaining claimed reserves. The readiness check requires the native partner balance to cover all unspent claimed revenue plus the overhead cap. It conservatively excludes any existing wrapped SOL from this operating-funds check.

## 9. Select the first P3 candidate

Selection is manual. “Ready for review” requires fresh dual-RPC graduation/position evidence, selected-repository and global reconciliations `MATCH`, active V1, no open or previously settled P3 deployment, at least 25 SOL recorded DBC lifetime volume, graduated SOL liquidity below 100 SOL, positive allocated reserve, separate overhead funding, configured first-live caps, and an executable bounded balancing quote.

The operator view never enables spending or creates an intent. Record the selected repo/pool, proposed amount, readiness timestamp and exact checks. If more than one candidate qualifies, choose one explicitly; do not start a market-selection scheduler.

## 10–12. Review, simulate and execute once

Follow [P3 sections 1–3](P3_FIRST_LIVE_RUNBOOK.md) without increasing its limits. Re-read and compare all [first-run settings](P3_FIRST_LIVE_SETTINGS.json) in the actual running process. When prerequisites are proven and the operator has approved this controlled execution window, temporarily enable **only P3**. P4 remains false.

Use `/api/platform-liquidity` one action at a time:

1. `intent.create`: exact selected `repoId`, integer `sourceAmount` and new idempotency key.
2. `GET`: review the exact pool, source wallet, LP authority, balancing swap, token deposit maxima, minimum LP, rules/version, terms hash and expiry.
3. `intent.review`: returned review and intent ID.
4. `intent.simulate`: that same intent ID; require successful preflight and bounded economic/wallet costs.
5. `GET`: inspect simulation and refreshed execution review.
6. `intent.execute`: same ID and returned execution review, only after explicit operator approval.

Investment including the balancing swap: **maximum 50,000,000 lamports (0.05 SOL)**. Additional account/network costs: **maximum 12,000,000 lamports (0.012 SOL)**. Combined wallet-value debit: **maximum chosen budget + overhead**, never more than 0.062 SOL. No automatic retry or additional attempt allowance.

Turn P3 back OFF after submission, including an uncertain response. Recovery may settle or rebroadcast the identical previously approved signed bytes. A disabled gate is not permission to abandon an unresolved reservation.

## 13–14. Verify and reconcile

Apply every exact wallet, token vault, LP, NFT authority and account/network-cost check in [P3 section 4](P3_FIRST_LIVE_RUNBOOK.md). Require a non-zero finalized mainnet economic debit equal to the durable settlement record. Record unused budget released and preserve the transaction/signature, slot, position, actual deposited tokens and separate costs.

Wait for normal fee indexing, then require selected-repository, platform revenue and liquidity reconciliations **MATCH**, with zero unresolved intents. Verify no duplicate economic action or unexplained reserve change. Record both P3 and P4 gates OFF. The public market may show “Protocol liquidity added” only for a reverified settled mainnet position with reconciled accounting.

## 15. P4 gate

Only the completed bounded P3 mainnet proof plus final `MATCH` satisfies P4's prerequisite. An eligible candidate, allocation, simulation, empty ledger match or local fixture receipt does not. P4 activation still requires its later controlled rollout, independent verification RPC and pinned P3 signature; P5 never flips its flag. Follow [Builder Reinvest](BUILDER_REINVEST_PLAN.md) for Claim → settled builder wallet → separate wallet-approved Reinvest into the same pool.

## Failure matrix

| Condition | Public / operator behavior | Operator action |
| --- | --- | --- |
| Stale observation or chain time (>120 seconds for operator gates, >300 seconds for the public display) | No progress number or graduated link; review/unavailable | Restore provider/worker; obtain fresh finalized evidence |
| RPC disagreement / wrong network | No verified update, operator alert | Investigate both providers; do not choose the convenient result |
| Incorrect config/threshold or canonical pool mismatch | Review, no readiness | Compare approved config, derived pool and actual account ownership |
| Target reached, migration incomplete | `CURVE`, 100%, migration pending | Observe migrator; separately review any fallback |
| Migrated flag without finalized migration proof | Review; never `GRADUATED` | Retrieve authoritative migration history |
| Missing creator/partner position or wrong NFT owner | Review; no claims/readiness | Investigate original migration positions |
| Duplicate event with identical evidence | No new event or alert | Normal restart/retry; no action |
| Conflicting duplicate graduation | Original evidence retained; review | Resolve contradiction without overwriting proof |
| Missing DAMM swap history / unsupported ordering | Volume unavailable; no verified readiness update | Restore history before reporting zero volume |
| Reconciliation mismatch or pending claim | Alert; no P3 readiness; graduated accounting hidden publicly | Reconcile source evidence and existing intent |
| No settled claim, allocation or operating SOL | Explicit readiness blocker | Complete reviewed prerequisite; do not use builder funds |
| Stale/invalid quote, simulation or cost bound | No eligible deployment | Wait and review a fresh bounded proposal |
| Lost transaction response / settlement mismatch | Keep intent reserved; P3/P4 stay off | Recover exact intent; no fresh spending |

## Evidence to retain

Store a sanitized dated report linking repo/config/curve/mint, migration signature and slot, both original positions, first fee/trade evidence, settled platform claim, allocation group and V1 amounts, reserve and wallet before/after, selected liquidity intent/review/simulation, actual mainnet LP signature/position/deltas, all final reconciliation results, running revisions and disabled gate readbacks. Never include signer material, credentials, authorization cookies or full signed transaction payloads in the report.
