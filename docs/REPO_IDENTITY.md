# Official repo.ing token identity — $REPOING

**Status: launched and finalized.** The token name is **repo.ing** and the actual on-chain ticker is **REPOING**. Earlier planning referred to `$REPO`; the launch used `REPOING`. Its metadata is immutable, so the on-chain ticker cannot be renamed.

[Open the canonical market](https://repo.ing/token/59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be) · [Finalized launch transaction](https://explorer.solana.com/tx/3tbwZgaxBHx2DLjHRvtwyy91fCbGKmvT9WQ1riP9QN3FP3KMEiYtQBN3tR9uPpZXUBRQM6QvMJEA3X9zXWKgbkpK) · [Revenue policy](REPO_TOKEN.md)

```yaml
project: repo.ing
symbol: REPOING
status: finalized_verified
github: https://github.com/New1Direction/repo.ing
github_repository_id: "1388219884"
network: Solana mainnet-beta
launch_path: repo.ing normal public-repository launcher
market: https://repo.ing/token/59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be
mint: 59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be
dbc_pool: Gda7Sig9EtVpB7EMVWG1eAAoX8kvq4j68nELsnq3Qfi7
dbc_config: 2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M
launch_transaction: 3tbwZgaxBHx2DLjHRvtwyy91fCbGKmvT9WQ1riP9QN3FP3KMEiYtQBN3tR9uPpZXUBRQM6QvMJEA3X9zXWKgbkpK
finalized_slot: 451058995
launch_at_utc: 2026-09-27T17:05:35.000Z
verified_at_utc: 2026-09-27T17:09:57.263Z
launcher_discoverer_wallet: 4euCWuZo1Ud3PfhFQr9ShmJVzqmARGqY2LR23YECDYce
team_wallet: 4euCWuZo1Ud3PfhFQr9ShmJVzqmARGqY2LR23YECDYce
builder_recipient_wallet: null
initial_buy_sol: "0.856011397"
initial_buy_tokens: "29999999.982493"
initial_buy_share: approximately 3%
fixed_supply: "1000000000"
decimals: 6
metadata_mutable: false
mint_authority: null
freeze_authority: null
discovery_version: 2
builder_allocation_version: 1
buyback_execution: disabled
protocol_liquidity_execution: disabled
builder_reinvest_execution: disabled
```

## Verified launch and initial purchase

The finalized creation transaction matches the recorded mint, derived DBC pool, approved config, protected creator, and designated launcher. The worker has indexed the market; its September 27, 2026 observation at 17:08:59 UTC returned **VERIFIED / MATCH**, with a zero fee-reconciliation difference. This is a dated observation, not a promise that later activity has already been indexed.

The launcher purchased **29999999.982493 tokens** for **0.856011397 SOL including trading fees**, approximately **3% of the fixed supply**. The transaction's total launcher-wallet debit was **0.878096477 SOL**: 0.856011397 SOL purchase, 0.022070080 SOL account deposits, and 0.000015000 SOL network fee. This records the launch purchase, not the wallet's current holdings after subsequent trading.

The operator designated the launch wallet as the team wallet. The creation transaction proves that it signed the launch. No builder payout wallet was bound at this verification checkpoint; receiving builder fees still requires the ordinary GitHub verification and wallet-binding flow.

GitHub confirmed that `New1Direction/repo.ing` is public and retains ID **1388219884** after its rename from `New1Direction/repoing`. Repository identity and canonical market identity are unchanged by that rename.

## Economic disclosures

- Fixed supply: **1 billion tokens, 6 decimals**, using the ordinary shared launch config and **85 SOL** graduation threshold.
- The verified builder has the normal **1% allocation after proven graduation**, with no additional vesting schedule. For this self market, that is an operator-related allocation separate from the initial purchase.
- The launch/team wallet receives normal limited discovery rewards: discovery v2, ending at curve completion, 30 days, or the 2.5 SOL lifetime cap, whichever comes first.
- Builder fees pay the verified bound wallet and remain separate from the **60% buyback reserve / 20% protocol liquidity / 20% treasury** policy. Eligible settled partner fees from this market qualify under that policy like other markets, after discovery obligations are reserved.
- The verified mint is now published here. Production `REPO_TOKEN_MINT` remains unconfigured at this checkpoint; publishing an identity does not configure or activate an executor.
- Buybacks, protocol liquidity spending, and Builder Reinvest remain **disabled**. There is no burn announcement, additional team allocation, or special launch configuration.

Use **$REPOING** and the verified mint in announcements. A matching name or ticker alone does not establish identity. Updating off-chain display text would not rename immutable on-chain metadata.
