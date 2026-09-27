# Protocol liquidity — 2026-09-26

[Documentation](README.md) / Protocol liquidity

**Deployed and locally verified; production spending remains disabled.** No production allocation policy or claimed DAMM platform revenue existed at the read-only preflight. This feature does not require a $REPO token. Buyback execution remains separately disabled.

**Subsequent policy and first-run lock:** [V1 60/20/20](REVENUE_POLICY_V1.md) is active. The [first-live runbook](P3_FIRST_LIVE_RUNBOOK.md) locks investment to **at most 0.05 SOL** plus **at most 0.012 SOL overhead**, with one manual, operator-reviewed attempt. Claimed platform revenue remains zero; the last finalized check of 16 indexed markets found none graduated. Execution remains off and no live LP deployment has occurred.

## What it does

An operator can use the liquidity portion of **settled platform fee claims** to deepen a repository's canonical graduated DAMM v2 pool. An atomic transaction swaps part of the reviewed SOL budget for that pool's token, then deposits both assets into a new LP position. Existing builder earnings, discovery entitlements, unclaimed fees, and buyback allocations cannot fund the economic budget. Any purchased tokens left after the bounded deposit remain in the protected partner wallet.

The new position belongs to the protected partner wallet. **It is not permanently locked.** The original migration positions retain their existing permanent locks. No LP withdrawal endpoint is included. Fees earned by these additional positions are not yet included in the original partner-position fee capture ledger.

## Eligibility and limits

Execution is off unless every `REPO_LIQUIDITY_*` field in [.env.example](../.env.example) is valid. There are no default production spending values. The operator must approve:

- The platform revenue split and active policy version.
- Minimum recorded repository volume and the target SOL balance in the graduated pool.
- Minimum and maximum deployment sizes, slippage, swap price impact, and rules version.
- A separate maximum for account deposits and network costs per transaction.

Qualification requires an indexed, finalized canonical launch, verified DAMM migration, reconciliation `MATCH`, the canonical SPL-token/SOL pair, SOL-only fee collection, sufficient recorded volume, and a pool SOL balance below the target. The current volume threshold uses indexed **DBC lifetime volume**; it does not represent post-graduation trading volume. The target is an eligibility threshold, not a promised final balance or a market-depth estimate.

Account deposits and network fees are separately bounded operating costs paid by the partner wallet, outside the economic liquidity reserve. Keep operating SOL funded separately; these costs are recorded on each intent and are not charged to a revenue-allocation bucket. The local rehearsal required about 0.01 SOL to create a position, making very small deployments inefficient. Review the current simulation for the actual cost.

## Authorization and workflow

All platform-fee, platform-revenue, and platform-liquidity endpoints require a valid encrypted GitHub builders session **and** an immutable GitHub user ID in `PLATFORM_OPERATOR_GITHUB_IDS`. A normal builder session grants no treasury access. Missing configuration denies access. Mutations require the same origin; responses use `private, no-store`.

`/api/platform-liquidity` is an operator API; no public trading or builder UI changes are included.

1. GET shows reserve accounting, eligible markets, and sanitized recent intents.
2. POST `intent.create` with repository ID, lamport budget, and a unique idempotency key prepares the exact pool, pair, source wallet, LP owner, output/deposit limits, minimum liquidity, policy/rules versions, and expiry.
3. GET issues a short-lived signed review tied to those terms and the operator's session. POST `intent.review` records it.
4. POST `intent.simulate` checks current policy, rules, eligibility, reserve, real SDK quotes, and separate economic/operating costs without broadcasting.
5. GET issues the execution review. POST `intent.execute` refreshes the checks and simulation, persists the signed transaction before sending, and verifies finalized settlement.
6. An unsubmitted intent can be cancelled. A submitted intent stays reserved until authoritative recovery resolves it.

Reviews bind a hash of the full immutable terms, including the complete rules. Changing limits without changing their version still invalidates an older review. Execution is serialized against reserve spending and policy activation. Existing treasury token holdings do not increase the deposit budget.

## Settlement and recovery

Settlement matches the finalized transaction to the durable signed message, exactly one swap and LP receipt, canonical vault and wallet token deltas, the derived position, NFT ownership, deposited amounts, minimum liquidity, economic debit, and operating cost. Only the verified economic debit consumes the liquidity allocation; unused reserved SOL becomes available again.

The worker recovers submitted intents without a signer. It can rebroadcast only the already authorized bytes. A known signature keeps funds reserved even if its receipt is temporarily unavailable. An expired transaction releases its reservation only after repeated receipt and historical-signature absence checks. Unknown or inconsistent evidence stays pending for review.

`reconcileLiquidity` checks reserve arithmetic and the completeness/bounds of persisted settlement evidence. It does not independently refetch every historical position; chain evidence is verified during settlement. Direct later transfers or withdrawals by the custody wallet require separate reconciliation work before supporting them in the product.

## Local verification

The integration test uses disposable wallets, `http://127.0.0.1:8909`, and the explicitly guarded `repoing_liquidity_test` database. It proves:

- DBC launch and graduation, DAMM accrual, exact platform claim, then allocation.
- Disabled/incomplete configuration, reserve overspend, wrong market, duplicate/open intents, review mismatch/expiry, and rules drift rejection.
- Spending the entire available reserve without double-counting its own reservation.
- Preserving pre-existing treasury token holdings and wrapped SOL value.
- Simulation, concurrent execution paying once, finalized swap/LP verification, and actual-debit reconciliation.
- Lost broadcast response, ambiguous history retaining the reservation, submitted-intent cancellation rejection, tamper rejection, and signer-free recovery paying once.

The operator tests exercise GET and POST on all three treasury routes: unauthenticated requests return 401 and non-operator builders return 403 before accessing a database or signer. Final verification passed 2 liquidity tests, 2 platform-revenue tests, 2 operator tests (including all 12 route-denial cases), 3 discovery-rule tests, and the production build. Local receipts are not mainnet proof.

Final local run: canonical DAMM pool `8xqzTtf8Hga9VRsb2KUo2sGcrsCh3FGYsaGCYxhFNWE7`; first position `Abnp6TBv1xvDnJ6yZ3nKKcc2FXRdrM7ZWGnYAi6SkMk2`, signature `3DdS1MXPdQcTdYM9h9Ef2vQoAe9gC3y4TMJj3UqRk6wevctYRMpR8eAcXJ35Jk274EF7FbYeAsiuXTby6UefXMyY`, economic debit 1,193,318 lamports and account/network cost 9,907,120 lamports. Lost-response recovery settled the second position `7EyA9jhohffuG1rienWctuHKWf417HVxbstqDnpa17xg`, signature `5zpMjNDxksUaMNqCTuMhjhMVj8MmSE3TMx3S5tGxVSqMcSDygpP3w9SKFTct2vaEAqTRxXQS8b1qtT4MRx9RMUyn`, debit 1,202,193 lamports. Reconciliation returned `MATCH`.

All recovery jobs ran in the later worker smoke check. Its launch/history checks could not reread the fixture launch after the deliberately bounded validator ledger pruned it; this was not treated as a passing full indexing cycle. Use a retained archive or a fresh fixture for a later complete replay.

## Rollout and remaining work

Apply additive migration `0014_protocol_liquidity` before the worker and web. The snapshot metadata now follows unique migration IDs and includes the complete current schema; deployed migrations 0012 and 0013 SQL are unchanged. The worker also restores builder-claim recovery initialization and discovery-recovery execution.

Deploy with `REPO_LIQUIDITY_EXECUTION_ENABLED=false`, set only the verified operator ID allowlist, and verify worker cycles and API denial responses. V1 and the first-run caps are now approved. Follow the [locked runbook](P3_FIRST_LIVE_RUNBOOK.md): execution still needs claimed, allocated platform revenue, an eligible graduated pool, and review of the exact mainnet intent. No automatic market selection or spending is enabled.

### Recorded deployment

Implementation `3bd9acc` is saved on private `New1Direction/repoing` main. Migration 0014 was applied through Drizzle after verifying the exact 0013 checkpoint hash; its new table was empty. Worker `a97c0f37-ba4c-457b-bd5f-f7a50b94af3b` succeeded. Three observed production cycles each verified 15 indexed markets with 15 `OK` fee results and no claim, allocation, discovery, liquidity, or platform-fee recovery errors. The pre-existing unavailable launch `1382497250` remains separate and unresolved. Web is configured with execution explicitly false and operator ID `285551516` (verified `New1Direction`); no policy or spending limits were activated.

Web `3924cc36-009c-4635-a88f-03808e165656` succeeded. Live `/`, `/launch`, and `/explore` returned 200; all three treasury APIs returned 401 with `private, no-store` for unauthenticated requests. Read-only inspection of the deployed code confirmed the disabled gate, exact operator allowlist, 16 preserved markets, zero policies, zero platform claims, and liquidity reconciliation `MATCH` with allocated/committed/settled/open all zero. No mainnet transaction was signed or sent for this release.
