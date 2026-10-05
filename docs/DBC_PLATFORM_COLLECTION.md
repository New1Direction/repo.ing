# DBC platform fee collection

The receiving treasury is **`FgzeYRRJLwd3aZQFBgn3a5KnN4mZixSRB9keYzoBm5Jy`**, supplied by the operator. The protected partner signer remains **`H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3`**. Existing DBC configs keep their fee authority; a reviewed claim sends available platform SOL to the treasury atomically.

## Which money moves

For the current 1.75% DBC fee (a new market's [launch fee](LAUNCH_FEE.md) is higher for its first 180 seconds and is split in the same proportions), 0.35% is Meteora's protocol fee, 0.994% is the builder share, and **0.406% is the partner share**, before discoverer rewards and integer rounding. Discovery rewards use half of eligible partner fees under each market's existing version, window and cap. The platform cannot collect those unpaid obligations.

For each repository, use integer lamports:

```
gross partner earned = sum(canonical partner swap-fee events)
discovery owed = versioned discovery earned - settled discovery payouts
expected pool partner balance = gross - discovery payouts - settled DBC platform claims
collectible platform SOL = expected pool partner balance - discovery owed
```

The expected balance must equal the finalized pool's partner fee balance exactly. Builder fees are a separate field and entitlement. Unenrolled legacy markets owe no discovery reward; their full partner share is collectible. Fees outside the reward window count toward platform revenue without extending discovery entitlement.

## Evidence and controls

- Primary and independent RPC must agree on finalized canonical pool/config bytes and network.
- Derive pool identity from the mint and approved config; verify creator, partner authority and SOL-only fee mode.
- One repository advisory lock serializes collection with discovery claims. Pending payouts block new collections.
- The review binds repo, pool/config evidence hash, exact amount, receiving wallet, expiry and maximum network fee (810,000 lamports, 0.00081 SOL: two signatures plus the bounded priority fee).
- Simulate signed instructions before saving or broadcasting. Save the fully signed intent before broadcast.
- Claim into fresh temporary token accounts, send the exact fee amount to the treasury, return both rent deposits to the signer, and close the temporary accounts in the same transaction.
- Verify finalized signed message, canonical claim event, exact treasury and fee-payer SOL deltas, exact quote-vault token debit, and zero temporary account balances. Store a `MATCH` receipt.
- Worker recovery reuses the same signed transaction. Unknown settlement blocks another claim; expiry is resolved only after no chain evidence remains.

Collection uses existing `platform_fee_claims` with `phase=DBC`; graduated claims retain `phase=DAMM`. The existing 60/20/20 allocation process consumes settled claims exactly once. Accounting allocations do not send SOL or execute buybacks.

## Operator procedure

1. Apply additive migration `0018_dbc_platform_collection`.
2. Deploy web with discovery eligibility filters before deploying worker or backfilling non-eligible partner events.
3. Run `node scripts/backfill-partner-fees.mjs` to audit missing historical partner events, then `--apply` to replay their finalized chain evidence. No balance or cursor is reset. If exact pool reconciliation still fails, investigate missing transaction history; never manufacture a credit.
4. Configure `PLATFORM_FEE_TREASURY_WALLET` and `GRADUATION_VERIFICATION_RPC_URL` on **web** as well as the independent verification setting on worker, then explicitly enable `PLATFORM_DBC_COLLECTION_ENABLED=true`. Buyback, P3 and P4 execution gates remain false.
5. On the protected web runtime, run `node scripts/collect-dbc-platform-fees.mjs review REPO_ID` and save its JSON to a private temporary review file.
6. Run `simulate REVIEW_FILE`; review amount, destination, fee and refundable deposits.
7. Run `claim REVIEW_FILE`. An expired or changed review must be regenerated and reviewed again. Record the receipt signature and `MATCH`.
8. Verify the remaining pool fees cover discovery obligations and the builder balance is unchanged. Allocate the settled claim under active policy using the existing reviewed allocation action.

The authenticated operator API offers the same review/claim at `/api/platform-fees/REPO_ID?phase=DBC`. There is **no recurring collection job**. Small claims that do not cover their network cost remain in the pool until they are economical to collect.

## Custody and later spending

The treasury wallet holds collected SOL. The protected signer pays network fees from its separate operating balance. A 60% reserve is accounting in the receiving wallet, not SOL automatically sent to a buyback signer.

P3 and buyback preparation reject allocations held in a different wallet from their proposed spending source. Moving authority or funding an executor later requires a separate reviewed setup. This routing change never enables buybacks, P3, P4 or automatic trading.

**Scope:** This collector handles DBC partner fees, including residual DBC fees after migration. The existing DAMM position collector still pays the protected partner wallet. Before the first graduated fee claim, review its destination/custody separately; do not assume this setting reroutes the DAMM path.

## Failure matrix

| State | Result |
| --- | --- |
| Unapproved config, wrong pool/mint/creator/fee authority | Reject |
| RPC data or network disagreement | Reject and refresh |
| Indexing gap or unexplained previous withdrawal | Reject; reconcile evidence |
| Pending discovery/platform payout | Wait for recovery |
| Expired, changed, wrong-wallet or replayed review | Reject |
| Insufficient operating SOL / new receiving wallet below rent minimum | Simulation fails; no broadcast |
| Amount no larger than network fee | Keep fees in pool |
| Lost broadcast response | Recover the saved signature; never create a replacement payout |
| Wrong receiver delta, fee, vault debit, event or rent refund | Keep intent pending for review; no allocation |
| Revenue held outside proposed spending signer | Spending preparation blocked |

## Verification

### Local rehearsal

Fifteen focused checks passed: seven end-to-end DBC collection checks, three existing graduated-fee/revenue checks, and five discovery-rule/operator checks. The production build and secret scan passed. A second seven-check DBC run uses a finalized-default connection to cover the explicit confirmed-preflight setting. No mainnet trade or test volume was generated.

### Production collection — September 27, 2026 UTC

- Additive migration 0018 applied. Fifty historical swap signatures replayed into the existing partner ledger without new creator credits.
- **24 finalized fee collections paid 187,668,768 lamports (0.187668768 SOL)** to the supplied treasury.
- Independent finalized RPC verified every receipt and the exact treasury balance. All 24 builder reconciliations, platform revenue and liquidity reconciliation returned `MATCH`.
- Network fees: **240,000 lamports (0.00024 SOL)**, paid by the protected partner signer. Temporary deposits were fully refunded.
- Remaining partner pool fees: **47,803,922 lamports**, exactly equal to unpaid discovery obligations. No additional platform balance remained at the checked snapshot.
- Builder fees remaining in pools: **643,727,768 lamports**. Collection did not withdraw builder fees.
- No pending platform payout remains. Buybacks, P3 and P4 remain disabled.

The first submission encountered a preflight commitment mismatch: a fresh confirmed blockhash was not yet visible to the CLI connection's default finalized bank. The deployed worker recovered the **same saved signature**, and it settled once with exact `MATCH`. Sending and recovery now explicitly use confirmed preflight, while evidence and settlement remain finalized.

[First receipt](https://explorer.solana.com/tx/5Usbz3AcZD5oR383UHSRYhNCGHSKLVAv35rRuxycHm9BDKKz4LY8zRZm8KCJYsmNnQTCdwvtz9EXpBiZyxTcEFuE) · [All 24 verified receipts](DBC_PLATFORM_COLLECTION_RECEIPTS.json)

These figures are a historical snapshot, not a promise that no new fees have accrued since.

The approved V1 allocation records 112601254 lamports for buyback reserve, 37533745 for liquidity, and 37533769 for treasury. The allocation is accounting only; all collected SOL remains in the receiving wallet. Revenue reconciliation is `MATCH`.

Final release: web `d71da63d-5531-4991-8069-29e3a4309f09`, worker `6709fac6-36e7-442e-b418-263072ccb6c1`, both successful. The running collector hash matches the tested source. Post-allocation revenue and liquidity reconciliation are `MATCH`; `/stats` returned 200 and the unauthenticated operator collector returned 401.
