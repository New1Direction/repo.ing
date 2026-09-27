# Mainnet DBC config — 2026-09-24

> Original configuration record. This config remains approved for legacy markets. New launches now select the [85 SOL profile](LIQUIDITY.md), whose activation and verification are recorded in [Liquidity review](LIQUIDITY_REVIEW.md). Deployment and rehearsal statements below describe the original setup.

**Created and verified on mainnet.** Transaction `2P5wyHJMbLc6gXbiaE1JvKwnfhtq9czARftMM2m7sutGaUWffsKcRvF4Ycbg9upPz7XEaAtyDSDmwT4quhDwQggy` finalized. The config account was fetched from finalized chain state and matched the app's fixed launch guard, SOL quote mint, fee recipients, 50/50 permanently locked liquidity split, and 29,954,748,784-lamport graduation threshold. [Solana transaction](https://explorer.solana.com/tx/2P5wyHJMbLc6gXbiaE1JvKwnfhtq9czARftMM2m7sutGaUWffsKcRvF4Ycbg9upPz7XEaAtyDSDmwT4quhDwQggy?cluster=mainnet-beta).

| Role | Public address | Secret custody |
| --- | --- | --- |
| repo.ing partner fee claimer, leftover receiver, and config payer | `H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3` | macOS Keychain service `repo.ing.dbc.partner`, account `production` |
| New DBC config account | `D7oz8xQ4seaNaEgiDS4fu3YJfmUvR5iPuznxuqKV4u1c` | macOS Keychain service `repo.ing.dbc.config`, account `production` |
| Per-pool creator and repository fee authority | `FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1` | Railway web and macOS Keychain; this is separate from the partner wallet |

The proposed config uses the exact parameters from the proven local [175/71 fee experiment](FEE_CONFIG.md) and `tests/fixed-config.mjs` with `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13`:

- SOL quote; ordinary SPL base token with six decimals; immutable token authority; one billion base tokens with 1,000 leftover.
- Fixed 175 basis point DBC trading fee, dynamic fee off, quote-token fee collection, and 71% creator share of the non-protocol trading fee. The nominal breakdown is 0.994% repository creator, 0.406% repo.ing partner, and 0.35% Meteora protocol before integer rounding.
- No pool creation fee; DAMM v2 migration target. The SDK curve calculates a **29,954,748,784 lamport (29.954748784 SOL) quote-reserve graduation threshold**. Its price points and liquidity weights match the local fixture.
- Zero immediately claimable migrated liquidity for either party; 50% creator and 50% partner permanently locked liquidity. The selected SDK migration fee option is `FixedBps100`; the explicit migration fee percentages are zero. Post-graduation economics for this exact config have **not** been rehearsed.

The mainnet config transaction was built using the dedicated Helius RPC and simulated before submission. The RPC reported a 10,000-lamport transaction fee for its two signatures and 5,974,080 lamports of rent exemption for the SDK's 1,048-byte config account: **5,984,080 lamports (0.00598408 SOL) estimated total**. The partner wallet was funded with 0.025 SOL before submission. The program created the account internally with one Meteora instruction and no separate System Program instruction.

The partner signer controls the platform's fee share. Make a protected recovery copy outside this Mac; losing the only copy could make those fees inaccessible. `DBC_CONFIG` has been set on Railway web and worker, and their deployments are in progress. Verify both deployments and worker behavior before relying on live indexing. Do not use the local-validator config address on mainnet.
