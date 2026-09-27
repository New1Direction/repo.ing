# repo.ing documentation

Launch open source markets. Every trade pays the builders.

## Use repo.ing

| I want to… | Read |
| --- | --- |
| Launch a repository, trade, or claim builder fees | [User guide](USER_GUIDE.md) |
| Manage earnings across repositories | [Builder dashboard](BUILDERS.md) |
| Configure optional builder email reminders | [Reminders and consent](BUILDER_REMINDERS.md) — delivery disabled until configured |
| Choose a token image | [Token artwork](TOKEN_IMAGES.md) |
| Find repositories by topic or activity | [Repository search](REPOSITORY_SEARCH.md) |
| Understand discoverer earnings | [Discovery rewards](DISCOVERY_REWARDS.md) |
| Understand liquidity and graduation | [Liquidity guide](LIQUIDITY.md) |
| Understand the 1% builder allocation | [Builder allocation](BUILDER_ALLOCATION_PLAN.md) |
| Read protocol metrics | [Analytics definitions and sources](ANALYTICS.md) |

## $REPOING and platform economics

- [Official identity](REPO_IDENTITY.md) — finalized mint, launch wallet, transaction, and initial purchase.
- [$REPOING and revenue policy](REPO_TOKEN.md) — ordinary repository-market rules; buyback execution inactive.
- [Self-launch economics](REPO_SELF_LAUNCH_REVIEW.md) — supply, fees, positions, and separation of builder and platform earnings.
- [60 / 20 / 20 allocation policy](REVENUE_POLICY_V1.md) — buyback reserve, protocol liquidity, and treasury.
- [Platform fee collection](DBC_PLATFORM_COLLECTION.md) — discovery reserves, receiving treasury, and verified receipts.

A reserve allocation is not an executed buyback. Protocol liquidity spending and Builder Reinvest remain disabled pending their documented activation requirements.

## Develop and operate

Start with [Architecture](ARCHITECTURE.md), [Development](DEVELOPMENT.md), [Contributing](../CONTRIBUTING.md), and [Security](../SECURITY.md).

| Area | Reference |
| --- | --- |
| Deployment and recovery | [Production setup](PRODUCTION.md), [encrypted backups](BACKUPS.md) |
| Canonical launch | [Launch coordinator](LAUNCH_COORDINATOR.md), [indexing](LAUNCH_INDEXER.md), [first-buy review](LAUNCH_REVIEW.md) |
| Trading and fees | [Trading](TRADE.md), [DBC fees](FEE_CONFIG.md), [accrual](FEE_ACCRUAL.md), [external swaps](EXTERNAL_FEE_INDEXER.md), [graduated fees](GRADUATED_FEES.md) |
| Identity and claims | [GitHub authority](GITHUB_VERIFICATION.md), [wallet binding](WALLET_BINDING.md), [claims](CLAIM.md), [reconciliation](RECONCILE.md) |
| Graduation operations | [Readiness](FIRST_GRADUATION_READINESS.md), [first-graduation runbook](FIRST_GRADUATION_RUNBOOK.md), [reserve alerts](RESERVE_ALERTS.md) |
| Revenue and liquidity | [Revenue accounting](PLATFORM_REVENUE.md), [protocol liquidity](PROTOCOL_LIQUIDITY.md), [first bounded deployment](P3_FIRST_LIVE_RUNBOOK.md) |
| Builder Reinvest | [Claim-first design](BUILDER_REINVEST_PLAN.md), [local verification](BUILDER_REINVEST_VERIFICATION.md) — production disabled |
| Discovery | [Trend sources, scoring, and review](TREND_DISCOVERY.md) |
| Interface | [Charts](CHARTS_AND_RESPONSIVENESS.md), [market usability](MARKET_USABILITY.md), [watchlists and badges](DISCOVERY_UX.md), [claim sessions](PERFORMANCE_AND_CLAIMS.md) |
| Local chain fixtures | [Meteora setup](METEORA_SPIKE.md#reproduce), [curve comparison](LIQUIDITY_REVIEW.md) |

## Reading verification records

Engineering guides distinguish local fixture checks from finalized mainnet receipts. Dated observations describe the state at that time; use the live application for current market activity. A successful deployment does not establish that every financial flow has been exercised. USD figures are display estimates; accounting and claims use exact SOL lamports.

[Back to the project](../README.md)
