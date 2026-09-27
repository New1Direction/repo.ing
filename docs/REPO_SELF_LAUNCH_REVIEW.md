# $REPO through the ordinary repository launcher

[Documentation](README.md) / [$REPO policy](REPO_TOKEN.md) / Ordinary-launch review

**Reviewed September 26, 2026, against production at 2026-09-27 02:09:47 UTC.** This is a read-only launch review. No mint was created, transaction prepared or signed, repository made public, or production setting changed. The operator intends to launch manually.

**Subsequent operator decision:** the ordinary self-launch design is accepted. Economics stay unchanged. Finalized launch evidence belongs in the [official identity record](REPO_IDENTITY.md). Wallets, initial purchase, publication and the launch transaction remain separate choices.

**Revenue routing update, September 27 UTC:** the later [DBC collector](DBC_PLATFORM_COLLECTION.md) adds settled DBC platform claims after unpaid discovery rewards are reserved. The revenue section below reflects that extension. The chain/config checkpoint remains the earlier read-only observation.

## Conclusion

The normal route fits: **$REPO can be the canonical market for `New1Direction/repo.ing`**, with the same builder, discoverer, curve and migration rules as other newly enrolled markets. No special config or accounting exception is required merely because the repository administrator also operates the platform.

The repository was renamed from `New1Direction/repoing` on September 27, 2026; GitHub verified that ID **1388219884** is unchanged. The original checkpoint below retains its historical name.

This replaces the earlier standalone 80/20, zero-insider-allocation proposal as the direction under review. It does not approve a launch transaction. The ordinary route includes a **1% builder allocation after verified graduation**, and that is an operator-related allocation for this particular repository.

## Verified checkpoint

| Item | Observation |
| --- | --- |
| GitHub identity | `New1Direction/repoing`, immutable repository ID **1388219884**; private, default branch `main`, no license returned by GitHub at inspection |
| Canonical market | No production market/reservation row for repository ID `1388219884` at the checkpoint |
| Official protocol mint | `REPO_TOKEN_MINT` unset |
| Production DBC config | [`2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M`](https://solscan.io/account/2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M) |
| Mainnet evidence | Genesis `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`; finalized config snapshot slot **450858355** |
| Config account owner | DBC program `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| Config bytes SHA-256 | `207be6160f1a44f6f1a64806236920a6c0771eb8fde38aa92f121450cf8bad0d` — matches the recorded builders-profile activation |
| New-launch enrollment | Discovery enabled, version 2; builder allocation enabled, version 1 |
| Spending | Buybacks, P3 liquidity execution and P4 builder reinvestment all `false` on the inspected web deployment |
| Revenue control plane | Active policy 600/200/200 permilles; eligible platform claims, allocations and buyback spending all **0**; no recorded graduation |

Production is changing as users launch markets. These are dated observations, not a launch-time reservation or future guarantee. Refresh the config, identity and existing-market check immediately before signing.

## Exact ordinary-launch economics

| Term | Applies to a new enrolled $REPO launch |
| --- | --- |
| Token | SPL token; **1,000,000,000 supply**, **6 decimals**, `1,000,000,000,000,000` base units |
| Authorities | Config `tokenUpdateAuthority=1` (`Immutable`). Finalized mint/freeze authority absence and metadata state must still be checked on the actual new mint |
| Builder tokens | **10,000,000 tokens / 1%**, one grant to the verified current repository administrator's bound wallet after proven graduation; changing ownership cannot create a second grant |
| Vesting | Graduation is the release condition. No additional cliff or linear vesting is configured; claimed tokens are transferable |
| Curve inventory | Config `swapBaseAmount=789,998,988,823,546` base units, about **79%** of supply |
| Migration inventory | Config `migrationBaseThreshold=200,000,002,257,872` base units, about **20%** of supply |
| Reserved remainder | Config supply minus those two fields is `10,001,008,918,582` base units. It covers the 10 million-token grant plus a small reserve/rounding remainder; actual settlement follows pool balances |
| Optional launch purchase | None, custom amount, or 1%/2%/3% presets; **maximum 3% of supply** in the atomic initial purchase. Purchased tokens are additional to a later eligible builder grant |
| Starting SOL reserve | No funded SOL depth is implied by virtual pricing. Actual purchases build the reserve |
| Graduation | **85 SOL of actual quote reserve**, `85,000,000,000` lamports. This is not cumulative volume; sells reduce progress |
| DBC trading fee | Fixed **1.75%**, dynamic fee disabled, collected in the SOL quote asset |
| DBC fee split | **0.994% builder / 0.406% partner / 0.350% Meteora**, nominal fractions of the fee-paying trade basis; individual events round to integer units |
| Discovery | Original launcher earns **50% of eligible actual partner DBC fees**, nominally **0.203%** of the same trade basis. Comes from the 0.406% partner share, with no added trader fee |
| Discovery duration | Earliest of curve completion, **30 days** from verified activation, or **2.5 SOL cumulative earned**. Paid amounts count toward the cap; already earned rewards remain claimable afterward. No DAMM discovery accrual |
| Migration | **Meteora DAMM v2**; configured migration-fee percentage **0%**, creator migration-fee percentage **0%**. Network/account costs remain separate |
| Graduated trading fee | Current target config has **1% base fee plus enabled dynamic fees**, SOL-only fee collection, **20% of trading fees to Meteora** |
| Initial migrated positions | **50% creator / 50% partner**, both permanently locked; no configured unlocked share. Fee claims remain possible |
| Position custody | Creator position controlled by the protected creator signer; partner position by the protected partner signer. GitHub verification gives the builder a claim entitlement, not direct ownership of the migrated position NFT |

The DBC builder percentage is `1.75% × 80% × 71%`. The partner percentage is `1.75% × 80% × 29%`. The creator's **71% of distributable DBC fees does not carry over as a 71% DAMM LP share**. The two original graduated positions start equal; future added positions can change their fractions of pool-wide fee earnings.

The configured DAMM migration fee account is [`Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp`](https://solscan.io/account/Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp). Its decoded fee numerator is `10,000,000 / 1,000,000,000`, dynamic fee `initialized=1`, protocol fee percent `20`, collect fee mode `1`.

### Initial purchase quotes

Read-only SDK quotes against the current config's untouched starting state:

| Preset | SOL input including DBC trading fee | Tokens received |
| --- | ---: | ---: |
| 1% | **0.279890706** | 9,999,999.993250 |
| 2% | **0.565175357** | 19,999,999.986562 |
| 3% | **0.856011397** | 29,999,999.982493 |

These are quote calculations, not signed transactions or all-in launch costs. Account/rent/network costs require the launch review. Zero configured pool-creation fee does not mean launching is free. The 3% limit applies to the initial bundled buy, not lifetime holdings or later purchases. If the operator buys the maximum and later qualifies for the 1% grant, those two sources together are approximately **4% of supply**, before other trades/transfers.

### Leftover custody and exact settlement

The reserved tokens remain in the DBC pool until migration. The configured receiver is the protected creator signer `FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1`. The ordinary allocation claim withdraws eligible leftover and transfers exactly 10 million tokens to the verified beneficiary. Residue remains on that protected signer; it is not automatically burned or added to liquidity.

The recorded local graduation rehearsal withdrew `10,001,008.918584` tokens, paid `10,000,000`, and left **1,008.918584 tokens**. That fixture differs by two token base units from arithmetic on the config thresholds because of execution rounding. Publish actual finalized settlement amounts, not the fixture as a future receipt. See [builder allocation evidence](BUILDER_ALLOCATION_PLAN.md).

Meteora also defines **quote surplus** if a completing swap leaves SOL above the migration threshold. This is separate from token leftover and ordinary trading fees. The current application has no dedicated surplus claim/accounting path. If surplus exists, inspect it at graduation and keep it out of builder-fee credits, discovery rewards and P2 allocations until separately reconciled; do not promise all excess SOL becomes migrated LP. [Official surplus and leftover rules](https://docs.meteora.ag/core-products/dbc/surplus-and-leftover).

## Entitlement, identity and wallet rules

The ordinary launcher does not require repository ownership. It verifies a public, non-archived GitHub repo, then uses the numeric repository ID and a database lock to enforce one canonical market. Names and tickers are labels, not unique token identity.

Consequently, **making this repository public lets someone else launch its canonical market first**. The existing flow cannot reserve a private repository for its owner. The first successful launcher chooses the metadata and receives permanent discovery attribution. Recheck immediately before signing; an existing market must be investigated rather than overwritten or duplicated. An uncertain submitted transaction must be recovered by its signature, not replaced with a second mint.

Use the normal repo.ing launch flow, funded by the operator's user wallet. Creating an unrelated mint manually elsewhere will not attach it to this canonical repository market.

Wallet constraints:

- Launcher must differ from the protected creator signer. A launcher using the protected partner fee authority would be unable to claim discovery rewards because that recipient is explicitly rejected.
- Choose a normal user wallet distinct from both protected signers. Its discovery entitlement is permanent, so disclose it if it belongs to the operator.
- The eligible current GitHub administrator must connect GitHub, prove wallet control, bind the builder recipient, and use the normal reviewed claim. Being the platform operator does not bypass this path.
- The builder allocation recipient cannot be the protected creator signer. A normal user wallet can be both launcher and verified builder recipient; that does not merge their ledgers.
- GitHub ownership or administrator changes affect future claim eligibility. The on-chain creator is the platform's protected signer; it is not automatically the GitHub user's wallet. This is a platform-enforced entitlement, not trustless GitHub ownership enforced by Solana.

## Recursive accounting review

| Inflow | Recipient/accounting path | Goes into 60/20/20 today? |
| --- | --- | --- |
| $REPO builder DBC or original creator-position DAMM fees | Repository builder earnings → verified claim → bound builder wallet | **No** |
| $REPO discovery reward | Existing discovery ledger → original launch wallet | **No** |
| $REPO 1% token grant | Existing allocation claim → verified beneficiary token account | **No**, tokens are not platform SOL revenue |
| $REPO partner DBC fees | Existing partner accounting, with discovery obligations preserved | **Yes**, after the DBC collector reserves unpaid discovery rewards and verifies the treasury payout |
| $REPO partner DAMM fees after graduation | Existing settled platform claim → reviewed revenue allocation | **Yes**, exactly like other canonical repo markets |
| Other repositories' settled partner fees | Same platform claim and allocation path | **Yes** |
| Deposits, token purchase proceeds, wallet top-ups, LP principal or future volume | Not settled platform fee claims | **No** |

**Two corrections to the proposed story:**

1. The repository's builder income reaches its bound beneficiary wallet; it does not automatically enter the protocol treasury or the 60/20/20 allocator. Routing it into that policy would require a separately specified funding/accounting change.
2. The current platform allocator has no exclusion for its own market. “Other markets fund future buybacks” is incomplete: **all eligible settled partner fees, including $REPO's, qualify**. Keeping ordinary behavior means accepting and disclosing that rule. Excluding $REPO would be a deliberate policy/code exception.

No duplicate credit is created simply because the same person controls the builder and platform roles. Creator fees, partner fees, discovery obligations, token grants and LP principal have distinct evidence and settlement paths; an eligible platform claim can be allocated once. The reviewed current paths do not silently transfer builder income into P2.

Future protocol buybacks could themselves produce fees in $REPO's market. Those fees are real expenses/revenue transfers, not new external demand or free profit. The existing volume aggregates do not exclude platform-originated trades. Before enabling a future executor, its review must distinguish externally generated activity from protocol spending and count net costs; recycled spending must not be presented as organic growth. No execution was enabled here.

Likewise, an operator claiming its own repository fees is a related-party payout. It can appear in factual protocol totals, but it is not the independent-maintainer claim case study. If the operator launches, its discovery rewards can also appear in the normal leaderboard; disclose the wallet relationship.

## Conflicts to resolve before publication and manual launch

1. **Publication:** the repository remains private. **September 27 UTC follow-up:** the operator approved AGPL-3.0-only and [LICENSE](../LICENSE) was added for original source, resolving the missing license at the original inspection. Complete the public-release review of source, tracked history and assets before switching visibility. Previous ignore checks are not a substitute for reviewing what a public repository exposes. The license choice does not authorize publication.
2. **First-launch race:** accept that the public launcher gives no owner-only reservation. Prepare the normal wallet and metadata, publish when ready to launch, then refresh the canonical-market check. This narrows the window; it cannot guarantee the operator is first.
3. **Distribution disclosure:** use the ordinary approximately 79% curve / 20% migration / 1% builder plus remainder accounting. Remove the standalone 80/20 and zero-insider claims. There is no additional team vesting. Disclose any initial purchase, builder recipient, discovery recipient and residual-token custody.
4. **Revenue wording:** keep builder fees separate and describe 60/20/20 as applying to eligible settled partner claims, including the self market. There is no “other markets only” rule today.
5. **Official identity after launch:** verify the finalized mint, canonical repo ID, config, pool, supply, authorities and enrollment before publishing the official $REPO address. Register that exact mint separately; a `REPO` ticker does not select `REPO_TOKEN_MINT` automatically.

Bought-back token disposition remains undecided. It need not block an ordinary market launch if disclosures clearly say buybacks are inactive and make no burn promise. The official mint alone must not activate buying, P3 or P4.

## Minimal manual sequence

1. Accept the ordinary economics and the disclosure decisions above; finalize the repo's publication review.
2. Prepare a funded normal wallet and the intended name/symbol, then make the existing repository public when ready. Preserve its numeric ID; a replacement repository would be a different canonical identity.
3. Open the normal repo.ing launcher for `https://github.com/New1Direction/repo.ing`. Verify the resolved identity and whether a market already exists.
4. Review the selected 85 SOL config, 1% grant, discovery terms, optional buy and actual account/network costs. The operator signs the normal launch transaction manually.
5. Verify finalized creation and indexing, immutable canonical repository binding, mint/config/pool, actual supply and authorities, launcher attribution and both enrollment versions. Publish only those proven official addresses.
6. Connect GitHub and bind the intended builder wallet through the existing claim flow. Accrued SOL fees can be claimed before graduation; the 1% token grant waits for verified migration.
7. Keep buyback execution, P3 and P4 off. Follow the existing first-graduation and bounded P3 runbooks when real eligible funds exist. P4 still requires a verified live P3 `MATCH`.

## Evidence and implementation references

Reviewed application commit: `a36654e`; inspected web deployment: `c11aba70-9a45-48a1-8b58-f87ebc3fe7f1`. Verification consisted of GitHub repository metadata, finalized mainnet account reads, production read-only database/settings inspection and pure SDK quote calculations. No launch simulation or live transaction was performed; future-mint and migration receipts necessarily remain pending.

- [GitHub identity/public checks](../src/github.mjs), [canonical launch coordinator](../src/launch-coordinator.mjs), [production launch route](../app/api/launch/route.js).
- [Launch profile](../src/launch-curve.mjs), [transaction preparation and guards](../src/meteora-launch.mjs), [initial-buy bounds/quotes](../src/launch-buy.mjs).
- [Discovery rules](../src/discovery-rewards.mjs), [discovery claim authority checks](../src/discovery-claims.mjs), [builder allocation](../src/builder-allocation.mjs), [builder claims](../src/claim.mjs).
- [Graduation and position verification](../src/graduated-fees.mjs), [platform fee claims](../src/platform-fees.mjs), [revenue eligibility and allocation](../src/platform-revenue.mjs).
- [First-graduation runbook](FIRST_GRADUATION_RUNBOOK.md), [P3 bounds](P3_FIRST_LIVE_RUNBOOK.md), [P4 gate](BUILDER_REINVEST_PLAN.md).
