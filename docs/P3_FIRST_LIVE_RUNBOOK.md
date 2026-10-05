# P3: first live liquidity deployment

[Documentation](README.md) / [Protocol liquidity](PROTOCOL_LIQUIDITY.md) / First live run

**Locked September 26, 2026. Execution stays OFF until a canonical market has graduated and sufficient platform fees have been claimed and allocated.** One operator selects, reviews, and manually executes one intent. No automatic market selection, allocation, spending, or fresh retries.

This is a bounded production proof. An empty accounting `MATCH`, a successful simulation, or a local-validator receipt does not complete it. P4 production activation requires the non-zero mainnet deployment to pass the settlement checks below and all final reconciliations to return `MATCH`. The subsequent operator instruction authorizes P4 implementation and local preparation now, behind a disabled gate.

## 1. Fixed envelope

The [first-run settings](P3_FIRST_LIVE_SETTINGS.json) are a non-secret configuration manifest. The application does not load this file automatically. Apply its values to Railway **web**, with execution false. Worker recovery does not need an enabled execution gate or a liquidity signer.

| Control | First-run bound |
| --- | --- |
| Revenue policy | Active V1: 60% buyback reserve / 20% liquidity / 20% treasury |
| Liquidity investment, including balancing swap | **At most 50,000,000 lamports / 0.05 SOL** |
| Additional account deposits and network cost | **At most 12,000,000 lamports / 0.012 SOL** |
| Combined wallet-value debit | **At most 62,000,000 lamports / 0.062 SOL**, and no more than the chosen investment budget plus 12,000,000 |
| Swap slippage / spot-price impact | At most 100 bps / 50 bps (1% / 0.5%) |
| Qualification | At least 25 SOL recorded DBC lifetime volume; graduated pool SOL balance below 100 SOL |
| Rules version | 1; full rules are pinned in the review hash |
| Position owner | Protected partner wallet `H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3` |
| Cadence | One reviewed intent, one manual execution attempt, then execution OFF |

The operator chooses a positive integer budget **up to** 0.05 SOL; 0.05 SOL is not a required spend. The configuration's one-lamport minimum allows a smaller reviewed budget, but the quote must still yield positive swap output and deployable liquidity. Reject uneconomic dust during review. At the full cap, half the budget swaps into the repo token and the other half caps the SOL deposit. Actual investment may be smaller; unused reserved SOL is released and leftover purchased tokens remain in the partner wallet.

The volume filter does not prove organic demand. The 100 SOL threshold is an eligibility check, not a depth estimate or a target that authorizes repeated spending. The additional LP is platform-owned and withdrawable. Original migration LP locks are unchanged. Fees on the additional LP are not yet part of the original partner-position fee ledger.

## 2. Go/no-go while execution is OFF

Record UTC time, running web/worker deployment IDs, code revision, operator GitHub ID, and the full settings. The configured operator is immutable GitHub ID `285551516` (`New1Direction`). Use the real GitHub builders session; ordinary builder sessions cannot operate treasury endpoints. Never copy auth cookies, sealed review tokens, private keys, RPC credentials, or signed transaction bytes into Git or the run report.

Require all of the following:

1. Finalized Solana mainnet genesis is `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`. Select one immutable repository ID manually. Record its mint, approved stored DBC config, DBC pool, canonical migrated DAMM v2 pool, and migration evidence. A graduation percentage alone is insufficient.
2. Verify canonical assets, supported SPL token/SOL pair, SOL-only fee mode, the qualification thresholds above, and current repository reconciliation `MATCH`. Index all finalized fee evidence first; investigate any mismatch rather than editing balances.
3. Platform fees from a graduated market are already finalized into the protected partner wallet. If a claim is needed, first inspect `GET /api/platform-fees/<repoId>`, review its amount and receiver, and manually `POST` its returned `review`. Wait for the verified `settled` claim, never merely a pending response. Capture its signature and exact credit. A claim is a separate reviewed transaction with separately recorded network costs.
4. Inspect `GET /api/platform-revenue`: active policy must be V1 `600/200`, with treasury receiving the remainder, and reconciliation must be `MATCH`. If necessary, manually `POST {action:"allocate", review:<reviews.allocate>}` from a fresh GET. Capture allocation group, claim signatures, and all three integer amounts. Allocation itself sends no transaction.
5. Verify the **remaining allocated liquidity reserve** covers the chosen budget. Only finalized, allocated DAMM platform claims qualify. For a full 0.05 SOL budget at 20%, at least 0.25 SOL of eligible claimed revenue is needed; use the actual reserve after rounding and prior commitments. Unclaimed fees, builder/discovery obligations, buyback reserves, and existing operating-wallet SOL cannot substitute for that allocation.
6. Record finalized partner SOL, wrapped SOL, repo-token balances, and existing liabilities. Ensure sufficient spendable SOL for the chosen budget plus the full overhead cap while preserving the other allocation buckets and operational obligations. Do not rely on gross wallet balance alone. Pause if the remaining operating funds are inadequate.
7. Liquidity reconciliation must be `MATCH`, with no open or unresolved intent and **zero prior settled live deployments** for this first-run procedure. There must also be no pending platform claim or conflicting treasury operation. No other operator runs a claim, transfer, policy change, or deployment during this window.
8. Buybacks stay disabled. Verify the production settings against the manifest and arrange access to turn the liquidity gate off immediately after the attempt. If any prerequisite is unknown or false, leave spending disabled and stop.

`GET /api/platform-liquidity` intentionally lists no eligible markets with execution off. Use read-only chain and reconciliation checks for prerequisites. Do not enable spending merely to discover candidates. `scripts/reconcile-repo.mjs` can run against the protected production environment with the selected repo ID and its approved DBC config; it needs no signer.

## 3. One manual execution window

The current API also gates intent preparation and simulation. Only after section 2 passes may the operator set `REPO_LIQUIDITY_EXECUTION_ENABLED=true` on web, apply that configuration, and confirm the **running instance** reports the approved rules. A staged Railway variable does not change a running process. Keep buybacks off and do not enable any scheduler.

Use same-origin requests from the authenticated operator session at `https://repo.ing`. These are separate actions with a human review between them; do not place them in a loop or an unattended execution script.

| Step | Endpoint / action | Required review or result |
| --- | --- | --- |
| Prepare | `POST /api/platform-liquidity` with `action: "intent.create"`, explicit `repoId`, integer-string `sourceAmount`, unique `idempotencyKey` | Save returned intent ID. Never replace the key to work around a timeout or duplicate response. |
| Inspect | `GET /api/platform-liquidity` | Locate that exact ID; compare every field below. Save sanitized terms and hash. |
| Review | `POST` with `action: "intent.review"`, `id`, and that intent's `review` | Must return `reviewed`. |
| Preflight | `POST` with `action: "intent.simulate"`, `id` | Must return `simulated`, `broadcast:false`, positive expected LP liquidity, and costs within both caps. |
| Final review | Fresh `GET /api/platform-liquidity` | Same ID and terms hash; compare simulation debit, economic debit and account/network cost. Use the fresh execution `review`. |
| Execute once | `POST` with `action: "intent.execute"`, `id`, and execution `review` | Record status and signature. A timeout, 409, or `submitted` status is not proof of failure. |

Review the mainnet network, repo/pool/mints, source wallet and LP owner, `platform-authority` lock mode, source budget, exact swap input, minimum swap output, maximum token A/B deposits, minimum LP liquidity, slippage and impact bounds, overhead cap, V1 policy, rules version, full rules, hash, and expiry. Bind the operator's approval to this intent and these values. No placeholder amount, pool, or unsigned review authorizes sending.

Preparation expires after 30 minutes; signed review windows are at most 10 minutes and also limited by the GitHub session. Complete the final review within the original review window. A stale quote, changed policy/rules, expired review, inadequate reserve, failed simulation, or excessive cost stops the attempt. Never increase limits automatically.

Execution repeats fresh validation and simulation, then persists the complete signed transaction, signature, LP mint, expected liquidity and last-valid block height **before** broadcast. The API serializes execution under advisory locks. A unique idempotency key, one open intent per market, state transitions, and exact receipt matching prevent a submitted intent from spending twice. The operator procedure restricts this first run to one intent globally; the API does not impose a global lifetime-one-deployment limit.

**Immediately after the single execution call returns or becomes uncertain, restore execution false and apply it to the running web instance.** Confirm the running gate is off before closing the window. Disabling the gate cannot revoke already signed/submitted bytes. The worker may still resolve or rebroadcast those exact authorized bytes, without a signer. It must not create a fresh transaction or select another market.

## 4. Finalized settlement proof

Use the durable intent and its exact signature. The settlement verifier in `src/liquidity-settlement.mjs` refetches the finalized receipt and verifies all of the following before setting `settled`. Preserve the public receipt and account observations in the run report; an explorer success badge alone is insufficient.

Let `S` = actual SOL swap input, `T` = actual repo-token swap output, `A`/`B` = repo-token/SOL LP deposits, `L` = new LP liquidity. All arithmetic uses integer base units.

| Evidence | Exact required check |
| --- | --- |
| Transaction | Finalized, no execution error; signature and compiled message equal the durable signed intent; exactly one canonical swap and one deposit receipt |
| Reviewed amounts | `S = reviewed swapAmount`; `T >= minSwapOutput`; `0 < A <= min(T, maxTokenA)`; `0 < B <= maxTokenB` |
| Wallet repo-token delta | `post - pre = T - A`; existing treasury tokens do not fund the deposit |
| Pool repo-token vault delta | `post - pre = A - T` |
| Pool SOL vault delta | `post - pre = S + B` |
| LP delta | The newly derived position's liquidity equals receipt `L`, equals stored `expected_liquidity`, and is at least the reviewed minimum |
| LP authority | Canonical program-owned position, correct pool and NFT mint; position NFT account holds exactly one NFT for the protected partner wallet, with no delegate |
| Economic investment | `S + B = settled_debit`, positive and no more than chosen source budget or 50,000,000 |
| Wallet-value debit | Native-wallet debit **plus wrapped-SOL account native-lamport debit**; use transaction pre/post balances, including account creation/closure |
| Overhead | Wallet-value debit minus `S + B = settled_network_cost`, from 0 through 12,000,000; total debit no more than chosen budget + overhead cap |

Record `meta.fee` separately and the remaining net account-deposit cost. Do not confuse rent deposits, temporary wrapped SOL, fees, and actual liquidity investment. Read the new position and NFT at finalized commitment; preserve pool/owner/mint and liquidity evidence. Verify the stored `settled_token_a`, `settled_token_b`, `settled_liquidity`, `settled_debit`, and `settled_network_cost` equal the receipt-derived amounts.

Then wait for the worker to refresh finalized DAMM fee evidence. Preserve the balancing-swap receipt separately; the trade series now includes finalized DAMM swaps on the canonical pool, but it is an index, not proof of this swap. Run the selected repository reconciliation, `reconcilePlatformRevenue`, and `reconcileLiquidity`: **all must return `MATCH`, with no unexplained difference or unresolved submission**. The liquidity ledger must record the non-zero actual economic debit exactly once and release unused reserved budget. Verify buyback/treasury allocations are unchanged and overhead is separately accounted for in the run report.

`reconcileLiquidity` checks database arithmetic and evidence completeness; it does not independently reread historical chain positions. The receipt/account verification above is mandatory in addition to that `MATCH`. A local receipt or an empty ledger match does not qualify.

## 5. Stop and recovery rules

- **Before submission:** cancel only `prepared`, `reviewed`, or `simulated` intents with `intent.cancel`, then turn execution off. Refresh/reprepare only after reviewing why the attempt stopped.
- **Unknown response or submitted signature:** turn execution off, retain the reservation, and inspect the same intent. Do not cancel it, create a replacement, manually release its reserve, or send a new transaction. Recovery reuses only durable signed bytes. Known signatures remain reserved even when a receipt is temporarily unavailable.
- **Expired with no chain evidence:** let authoritative recovery perform repeated receipt/history checks before marking it aborted. Expiry alone does not prove absence.
- **Finalized chain failure:** stop the rehearsal, record the failed receipt and actual network cost; releasing economic reserve does not refund that fee. No automatic second attempt or repeated overhead allowance. A replacement requires a fresh operator review of the remaining run budget.
- **Any delta mismatch, unsupported position, or reconciliation problem:** keep spending off and preserve evidence for investigation. Never edit balances to produce `MATCH`. P4 stays gated.

## 6. Completion record and P4 handoff

Store a sanitized dated report with:

- UTC start/end, running deployments/revision, operator ID and approved settings/hash.
- Repo ID, config, mint, DBC/DAMM pool, migration proof and qualification snapshot.
- Finalized funding claim signatures/amounts, allocation group, V1 split, reserve before/after, operating-funds check.
- Intent ID, idempotency key, terms hash, chosen budget, review times, simulation and exact minima/maxima.
- Mainnet signature, slot, new position/NFT, LP owner and all receipt-derived deltas above; any failed-attempt costs.
- Final repository/revenue/liquidity reconciliation output, no unresolved intent, and running execution gates verified off.

Only this complete, non-zero settled proof with final **MATCH** unlocks production activation of [P4 Builder Reinvest](BUILDER_REINVEST_PLAN.md). Its implementation and local rehearsal are now authorized in advance. The existing earnings card offers **Claim** or **Reinvest**, with reinvestment going only into that same repository's canonical graduated pool after a settled claim and separate wallet approval. Keep approvals, progress, and receipts within that flow. No strategy picker, cross-pool routing, market-selection automation, or spending scheduler.

## Recorded lock checkpoint — not a live deployment proof

On September 26, 2026 at `21:05:30.124Z`, production still had V1 active, zero claimed/allocated revenue, no liquidity intents, both accounting reconciliations `MATCH`, and liquidity execution false. The last finalized graduation check, at `20:56:29.319Z`, found none among 16 indexed markets; this is a snapshot, not a monitor.

At `21:08:28.038638Z`, Railway readback matched every value in the manifest, with buybacks still disabled and operator ID `285551516`. Values were saved with `--skip-deploys`: they are **staged**, not yet loaded by the running web process. Deployment `3924cc36-009c-4635-a88f-03808e165656` remained successful and disabled. The manifest passed the deployed configuration parser, cap arithmetic, and rejection of each missing required field. No new app deployment or mainnet transaction was needed to lock the procedure. The first live proof and P4 gate remain pending.
