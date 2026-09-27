# Official $REPO identity

**Status: awaiting manual launch and finalized verification.** No official mint or market is published in this record. A token named REPO is not sufficient proof of identity.

The accepted design is the ordinary canonical market for the repo.ing source repository. [Launch economics](REPO_SELF_LAUNCH_REVIEW.md) · [Revenue policy](REPO_TOKEN.md)

```yaml
project: repo.ing
symbol: REPO
status: awaiting_verified_launch
github: https://github.com/New1Direction/repo.ing
github_repository_id: "1388219884"
network: Solana mainnet-beta
launch_path: repo.ing normal public-repository launcher
market: null
mint: null
dbc_pool: null
expected_dbc_config: 2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M
launch_transaction: null
finalized_slot: null
verified_at_utc: null
intended_launcher_wallet: 4euCWuZo1Ud3PfhFQr9ShmJVzqmARGqY2LR23YECDYce
team_wallet: 4euCWuZo1Ud3PfhFQr9ShmJVzqmARGqY2LR23YECDYce
launcher_discoverer_wallet: null
builder_recipient_wallet: null
initial_buy_sol: null
initial_buy_tokens: null
buyback_execution: disabled
```

`null` means **not selected or not verified**, never zero or an official placeholder address. In particular, the initial buy is undecided in this record; zero may be entered only after the operator chooses no buy and the finalized transaction verifies it.

The operator designated `4euCWuZo1Ud3PfhFQr9ShmJVzqmARGqY2LR23YECDYce` as the intended launch and team wallet on September 27, 2026. The address format is valid; wallet control, funding, the actual launch purchase, and discoverer attribution still require verification. The builder recipient remains unbound in this record and must use the normal GitHub verification and wallet-binding flow. The existing platform-fee treasury address is unchanged.

GitHub confirmed the repository rename from `New1Direction/repoing` to `New1Direction/repo.ing` on September 27, 2026. Its immutable ID remains **1388219884**, so this is the same canonical repository; the rename does not create a separate market identity.

## Disclosures carried with this identity

- Fixed supply: **1 billion tokens, 6 decimals**, using the ordinary shared launch config.
- The verified builder has the normal **1% allocation after proven graduation**, with no additional vesting schedule. For this self market, that is an operator-related allocation.
- The original launch wallet receives normal limited discovery rewards. Publish the operator's relationship to that address if applicable.
- Builder fees pay the verified bound wallet and remain separate from the 60/20/20 platform revenue policy. Eligible settled partner fees from this market qualify under that policy like other markets.
- Buybacks, P3 spending and P4 reinvestment are not activated by publishing this token identity. There is no burn announcement.

After launch, replace the pending fields only from finalized chain evidence and the matching canonical repository record. Preserve the transaction and verification time so later copies can be checked against this page.
