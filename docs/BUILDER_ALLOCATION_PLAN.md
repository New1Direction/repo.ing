# Approved builder allocation and discovery reward update

[Documentation](README.md) / Approved reward design

**Approved September 25, 2026. Status: ACTIVE — the 1% builder allocation and discovery v2 are deployed and live for new launches (config `2YbBp7…`, 2026-09-26).** Existing market terms are unchanged.

## Locked product decisions

| Rule | Approved policy for newly enrolled launches |
| --- | --- |
| Builder token allocation | Exactly 1% of the fixed 1 billion supply: 10 million tokens |
| Funding | Reserve tokens within the existing supply; no purchase or extra minting |
| Recipient | The payout wallet bound by a currently authorized GitHub repository admin |
| Unlock condition | Successful, verified graduation into the canonical DAMM v2 pool |
| Claim limit | One allocation per canonical repository market; changing owners or payout wallets does not create another grant |
| Builder trading fees | Continue under the existing DBC and graduated LP fee rules |
| Launcher discovery reward | 50% of actual eligible partner DBC fees, capped at 2.5 SOL lifetime earned |
| Discovery earning window | Ends at curve completion, 30 days, or the lifetime cap, whichever occurs first |
| Existing markets | Preserve their original curve, allocation, and recorded discovery version |

The 85 SOL graduation threshold, 3% optional launch-buy cap, and 50/50 permanently locked migrated LP allocation remain the intended settings. Reserving the builder tokens changes the curve's available inventory, so its exact quotes and migration allocation must be recalculated and verified.

## Builder allocation behavior

The allocation is reserved even when no owner has connected. An eligible owner can verify GitHub and claim earned trading fees before graduation. The token allocation becomes claimable only after graduation is proven. If the market never graduates, it remains locked.

At claim time, recheck current GitHub admin authority, immutable repository ID, saved wallet, allocation enrollment, canonical mint, migration evidence, reserve availability, and previous payout state. The recipient receives exactly 10,000,000 tokens, or `10_000_000_000_000` base units for a six-decimal mint. Any SDK rounding remainder is accounted for separately.

Changing repository ownership before a claim changes who can pass the current-authority check. An allocation already settled to a previous eligible recipient cannot be reclaimed or paid again. The site must make the saved recipient and one-time nature visible before confirmation.

Prefer Meteora's supported reserved-token withdrawal path. Its leftover withdrawal is available only after migration and pays the configured receiver; it does not verify GitHub ownership. A protected platform authority and an explicit token transfer to the verified recipient are therefore required. Validate an atomic withdrawal/transfer where supported, and retain a durable signed intent before broadcast. Do not describe this as a trustless GitHub escrow. [Official leftover behavior](https://docs.meteora.ag/core-products/dbc/surplus-and-leftover).

### Hugging Face model markets

Owner decision (2026-10-02): model markets keep the allocation under the same rules, with Hugging Face authority in place of GitHub's. A model launched on an allocation config is stamped like a repository (never with the verification bonus). After verified graduation, the model's current owner on Hugging Face (the user who owns it, or an admin of the owning organization; SSO- or MFA-restricted organizations fail closed) claims it once. Authority is re-checked at claim time, and the grant goes to the wallet that user bound through the model's Hugging Face binding. A binding made for a previous owner, or a change of owner, user or binding since the review, is refused. One grant per market, ever. Migration 0052 opens `markets` and `builder_allocation_claims` to model market ids for this. Everything stays behind `HF_MARKETS_ENABLED`.

## Discovery versioning

The existing discovery v1 cap is 1 SOL. Add a new immutable policy version for the approved 2.5 SOL cap; calculate earnings from the market's stored version. Do not replace the global cap and thereby rewrite existing obligations.

Retain aggregate integer rounding, the finalized chain timestamp boundary, canonical DBC-only evidence, inclusion of the completing swap, and claims of already-earned rewards after the earning window closes. Paid rewards count toward the lifetime cap. Builder fees remain separate.

At the current nominal 0.203% reward rate, the new cap requires approximately 1,232 SOL of eligible volume. A market may graduate or expire before earning that amount. The reward is funded by actual partner fees, with no upfront reward deposit. Compared with v1, a market reaching the new cap distributes 1.5 SOL more of partner revenue to its launcher.

## Product presentation

Use the existing GitHub-style cards and claim flow:

- **Builder allocation — 1%:** show 10 million tokens, locked/available/pending/claimed state, saved recipient, and a finalized receipt after payment.
- **Builder fees:** retain available, lifetime earned, and paid values separately from token grants.
- **Discovery rewards:** show the cap from the market's stored policy, lifetime earned, paid, available, and when accrual ends.

Do not show the new benefits as active on historical markets or on launches created before activation. “Claim all” must preserve independent results and receipts for each kind of payout.

## Implementation and activation gates

1. Prepare the new curve/config with the exact fixed-supply reservation. Compare SDK quotes, first-buy limits, sold supply, migrated supply, leftover balance, and permanent locks.
2. Add immutable enrollment and one-time allocation settlement records. Keep token grants separate from SOL builder earnings, discovery rewards, and protocol statistics.
3. Implement protected payout review, simulation, exact token transfer verification, replay protection, and recovery after an uncertain broadcast.
4. Add discovery v2 across launch enrollment, indexing, summaries, claims, recovery, and UI while exercising v1 compatibility.
5. Rehearse real local migration, allocation payout, concurrent claims, wallet or GitHub authority changes, repeat rejection, and restart recovery. Confirm existing fee claims and old-market reconciliation still work.
6. Prepare a concrete mainnet config transaction and simulate its account deposits and network cost. The previous config cost 0.00598408 SOL; that historical receipt is not a quote for this change. Account and claim transaction costs still apply even though the tokens are reserved from supply.
7. Deploy compatible schema, worker, and web; create and verify the reviewed config; activate only for new launches. Retain all configurations already used by existing markets.

Record subsequent activation evidence with the config, finalized transaction, and release receipts. A deployment alone is not proof of a completed allocation claim.

## Gate 1 rehearsal record — 2026-09-26

The `builders` profile is the proven 85 SOL `balanced` curve with one change: `leftover` 1,000 → 10,001,000 tokens, withdrawn after migration to the protected creator signer (the production launch guard already accepts it; the fee claimer stays the partner wallet). On the local Meteora fixtures:

- Quotes at 0.1/1/5 SOL execute exactly and are ≈2.4% shallower than `balanced` (3.5947T/34.8799T/154.0771T base units); fees are identical 175 bps. The maximum 3% launch buy costs 0.856011397 SOL, versus 0.834542274 SOL on `balanced`, for the same 3% token cap.
- Graduation at exactly 85.000000000 SOL: the graduating buyer holds 789,998,988,823,545 base units; migration moves ≈200,000,002,257,871; supply conservation is exact at 1,000,000,000,000,000.
- Leftover withdrawal pays 10,001,008,918,584 base units — the 10,001,000-token floor plus 8,918,584 base units of curve rounding residue. The grant is always covered; the residue stays on the protected signer.
- Both migration positions are permanently locked with bit-identical liquidity, a 5000 bps (50/50) split, zero unlocked units, and the creator position NFT held by the creator signer. The DAMM v2 destination pool is owned by the cp-amm program.
- `tests/launch-curve.test.mjs` and `tests/launch-first-buy.test.mjs` now include the `builders` profile permanently (9/9 with `tests/market-config.test.mjs`).

## Gate 6 creation and gate 7 activation — 2026-09-26

After the operator funded the wallets (partner 0.053 SOL, creator signer 0.186 SOL), the unsigned simulation passed and matched the reviewed numbers exactly (instruction sha256 `28b20b41cf3d1a2324fb68cb3237de87b5af2ff167f93a6f97f0f25ebb7bff7d`, account-data sha256 `207be6160f1a44f6f1a64806236920a6c0771eb8fde38aa92f121450cf8bad0d`, debit 5,984,080 lamports). With the approved values set, config `2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M` was created and finalized in transaction [`2VWMgSweTPweXQiJJknVEYkyVMFP9abEzNSPgiqoMbUdaUdnJfqakSHwbsyo6Zx7EQpoQAFzT74xTT21549gpkVb`](https://explorer.solana.com/tx/2VWMgSweTPweXQiJJknVEYkyVMFP9abEzNSPgiqoMbUdaUdnJfqakSHwbsyo6Zx7EQpoQAFzT74xTT21549gpkVb?cluster=mainnet-beta); the finalized account matched the simulated bytes and decoded with the expected threshold and start price.

Activation: `DBC_CONFIG` set to the new config on web and worker; `DBC_LEGACY_CONFIGS` now retains both prior configs (`D7oz8x…` original, `261xpZ…` 85 SOL); `BUILDER_ALLOCATION_CONFIGS` set on web only. Worker `9358f922-b270-41bb-9a70-897e92f9a92f` then web `b7c6315d-2dd7-4235-a838-4ffc00543c99` deployed and are Online with zero worker errors. Live checks: the launch page for an unlaunched repository shows the "1% for the builders / 10 million tokens reserved" card; `/api/allocation` still answers `enrolled:false` for existing markets. The first real launch under the new config, its reserve accounting, and the first allocation claim remain to be observed in production.
