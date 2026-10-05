# Graduated builder fees — 2026-09-25

The 85 SOL profile uses the existing DAMM v2 migration configuration `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp`. A finalized mainnet read confirms `collectFeeMode = 1` (quote/SOL only), 20% protocol fee share, and a 100 bps base fee with dynamic fees enabled. Do not represent the pre-graduation 0.994% builder rate as the post-graduation rate. The creator owns approximately 50% of permanently locked LP liquidity.

## Fee evidence and accounting

`src/graduated-fees.mjs` derives the destination from the approved DBC config and canonical mint, verifies the finalized migration instruction, and identifies its original creator position. It reads the pool, position, and position NFT together at one finalized bank. Program ownership, mint pair, NFT ownership, permanent locks, and SOL-only collection are checked. Unsupported asset modes fail explicitly rather than treating token fees as SOL.

The installed SDK computes position entitlement from integer fee-growth/checkpoint values. Lifetime earned equals unclaimed SOL plus the position's cumulative claimed SOL. Positive increases are stored as append-only `damm_fee_events`, with the finalized slot, raw public account evidence, evidence hash, migration signature, and a unique position/cumulative-entitlement key. These are account checkpoints, not invented swap events. A decreasing entitlement is an error. The `builder_fee_credits` view combines DBC transaction credits and DAMM checkpoint credits for lifetime earnings, badges, dashboard totals, and reconciliation.

Reconciliation compares outstanding fees against both pools and independently compares DAMM cumulative withdrawals to settled DAMM payout amounts. It does not manufacture a payout to explain an external withdrawal. DAMM trade history was not added to the DBC chart or volume series by this change, and graduated trading used the verified Meteora link. Both came later: finalized DAMM swaps are indexed into `damm_trade_events` and continue the chart, and the trade panel trades the graduated pool.

## Payouts and recovery

Existing current-GitHub-admin checks, bound wallet proof, expiring reviews, paid-total replay protection, and repository locks apply. A single signed transaction can pay remaining capped DBC fees plus the creator's DAMM SOL fees. DAMM's supported claim instruction withdraws all accrued fees, so graduated reviews explicitly include fees earned before confirmation. DBC-only reviews retain their exact cap.

Before broadcast, the signed transaction, expected amounts, signature and expiry are durable. Settlement checks the exact transaction message, both program claim events, zero base-asset payout, and the bound recipient's SOL delta with account rent separated. The worker can settle a lost response or rebroadcast only the identical previously authorized transaction. It has no payout signer secret. A finalized failed transaction or twice-checked expired absent transaction can be aborted; unresolved evidence blocks another payout.

## Verification

- Existing claim security and claim-all suite: 9 passed.
- Local graduation integration: 1 passed, including actual 85 SOL migration, buy and sell, finalized fee indexing, repeat indexing without duplicate credit, canonical mint substitution rejection, non-admin rejection, reviewed combined payout, repeat review rejection, lost-broadcast recovery, and detection of unexplained withdrawals.
- Local earned and settled payout total: `860750817` lamports; reconciliation `MATCH` before the deliberate discrepancy test.
- Local migration: `4PU8vTX4ngwCLWkAejb75nFmJYp5abrEHQSfLMvuzAKdb3BHdLT9GZvy9Lq89XNgiezDgPF5TWJHzNTHB7PbeEh2`.
- Local payout: `3okvXYNCSLtUu7QzbDHoiv8rG7FwWASVS9viYw5zzyShC8sPg7ribwoNdWA4jYaxHiAvgX3sG3BUhj4DmavofwQF`.
- Local recovered payout: `RV55FjoyaywfvqfRhqGMatmcqTGPsLMimhBzzSugu4M4xKWCNk8PTfo9qabFbXYA93mtiAdMg4sQtyeT5ZnRd2v`.
- A second complete run also injected a new DAMM trade after payout preflight, before broadcast. The recovered receipt included those later fees exactly: `861150847` lamports lifetime earned and paid, `MATCH`. Recovered signature: `3QzFcvv8X36vg5czzU5F8E2r6sENBLHmcUXM37HZ6CfL2czEKnG6J6oyTDrEfEo7t35Ex6XYh3jCxGDqL9GZCozG` (local only).
- Production build passed. No mainnet graduation, new market, swap or builder payout was sent as part of this rollout.

Meteora documents its automatic migrator and a manual fallback in the [official SDK flow](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/main/packages/dynamic-bonding-curve/README.md#flow). The mainnet migration authority held `66858465407` lamports at this check. Actual mainnet graduation still requires observing a pool reach its threshold and the migrator complete; local tests cannot prove that external service's future execution.


## Partner position capture — 2026-09-26

The permanently locked **partner** LP position (the config's `feeClaimer`) earns roughly half of every post-graduation fee and previously had no capture path. It now shares the same evidence pipeline as the creator position: one finalized bank snapshot covers both positions and their NFTs, the partner NFT must be held by the config fee claimer with exactly one undelegated token, liquidity must be permanently locked, and only SOL-side entitlement computed from fee-growth checkpoints is accepted. Credits land in `platform_fee_events` (append-only, one row per position/cumulative-entitlement checkpoint) and never mix into builder credits, discovery rewards, or protocol statistics.

Claims are reviewed platform actions: the builders-scoped session seals an expiring review for the exact indexed amount; the protected partner signer (web only) executes only that reviewed intent through `claimPositionFee2`, paying the protected partner wallet. One pending intent is allowed per market; the signed transaction is durable before broadcast; settlement verifies finalized success, bounded receiver lamports, and an exact partner claim-checkpoint increase; lost responses are recovered by the worker from the identical recorded intent; replayed or expired reviews, wrong receivers, and any drift between indexed and on-chain amounts fail closed. Reconciliation checks the platform ledger independently (`platform_fee_events` vs on-chain earned, settled claims vs on-chain claimed) and returns `MISMATCH` on divergence.

Local proof (`tests/platform-fees.test.mjs`, 1 test): graduate at exactly the threshold → DAMM volume → both positions accrue and index independently (partner 8,020,581 lamports vs creator credits alongside curve fees) → zero-accrual claim rejected → wrong receiver, wrong amount, and expired review rejected before broadcast → exact settlement with the partner claim checkpoint → replay rejected → settlement-tamper rejected → second accrual claimable → lost-response recovered exactly once → reconciliation `MATCH` with the independent platform checks. Migration `0012_platform_fee_capture` applied before worker `8f878386-fa0f-49a1-8cac-6923af1a138c` and web `190ca490-98c4-4d57-819c-4b95d03b0a5e`; the worker resumed all markets with no fee errors and `/api/platform-fees/*` requires the builders session (401 unauthenticated). No production market has graduated yet, so the first live capture remains to be observed.
## Production rollout

Additive migration `0010_graduated_builder_fees` was applied through the existing authenticated Railway SSH connection using the Drizzle migrator. Worker deployment `2e9b9476-a1c0-4e43-81db-e3b7a6c47bc5` succeeded with the new primary config and the original config allowlisted. Its runtime verified the 85 SOL threshold and all 13 indexed markets reconciled `MATCH`. Two worker cycles showed no fee errors or pending creator/discovery recoveries. The previously unavailable unindexed launch `1382497250` remained unchanged. Web activation and final live checks are recorded in `LIQUIDITY_REVIEW.md`.
