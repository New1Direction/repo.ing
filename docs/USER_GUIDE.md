# Using repo.ing

[Documentation](README.md) / User guide

## Find a market or repository

[Explore](https://repo.ing/explore) starts with **All markets**, followed by new markets, graduation leaders, builder earners, and discoverers. The separate **Find repos** tab shows public repositories gaining attention, with source evidence. Selecting a candidate opens the existing repository review and launch flow; nothing launches automatically.

On **Find repos**, search names/descriptions, choose **No market yet** or **Live markets**, and narrow by **Gaining stars** or **Recent releases**. Searches cover fresh tracked candidates, not all of GitHub. Pasting a GitHub repository URL uses the ordinary repository resolver and opens its market or launch form. An approved trend candidate keeps its **Review & launch** action. Scores still expand into the original source evidence. Optional natural-language matching requires the server-side TypeSafe integration; ordinary search and filters remain available without it.

[Stats](https://repo.ing/stats) shows protocol activity, settled builder payouts, and platform reserves. [Metric definitions](ANALYTICS.md) explain the periods and accounting.

## Connect a wallet

Select **Connect wallet**, then choose an available Solana wallet. repo.ing supports Phantom, Backpack, MetaMask's Solana connection, and compatible Solana Wallet Standard wallets that provide the required transaction and message signing features.

The site remembers the selected wallet in this browser and attempts to restore an authorized connection when you return. Your wallet may still require unlocking or reconnection. The wallet menu lets you copy your address, view holdings, switch wallets, or disconnect. repo.ing never asks you to enter a seed phrase.

Keep some SOL available for transaction fees and token-account costs. The Buy panel shows the connected wallet's SOL balance; spending the entire displayed balance may leave insufficient SOL for those costs.

## Read a market chart

Choose **1H**, **24H**, **7D**, or **All**; switch between **Candles** and **Line**, or **Price** in SOL and **MCap** in estimated USD. Hover or touch the chart for price and volume details. Drag to pan, pinch to zoom, or use the zoom/reset buttons. Keyboard users can focus the chart and press `+`, `-`, or `Home`. **Chart details & data** contains a readable price table.

Prices come from finalized pool swaps. Empty periods stay empty, and a delayed update is labeled. USD values use today’s SOL price. After verified graduation, the chart continues with finalized swaps from that repository’s canonical DAMM pool. Until its first indexed DAMM price, the curve history is labeled clearly. Use the verified Meteora link to trade. [Data definitions](CHARTS_AND_RESPONSIVENESS.md).

## Launch a repository market

1. Paste a public GitHub repository URL into [repo.ing](https://repo.ing). Private and archived repositories are not eligible.
2. If the repository already has a canonical market, open that market. A rename does not create a new repository identity.
3. Review the repository, token name, ticker, and suggested image. Use **Change image** to choose another project logo or owner avatar, or **Upload image** for your own PNG, JPEG, WebP, or GIF up to 2 MB. The preview fits the full image without cropping; the selected artwork is saved at launch. [Image details](TOKEN_IMAGES.md).
4. Choose **No buy**, a 1% or 2% preset, or **Max 3%** for the optional first purchase. The percentage refers to total token supply.
5. Review the simulated launch cost and allocation, then approve the transaction in your wallet.
6. Wait for confirmation and open the market from the success card. If the transaction is pending, check its receipt before submitting another launch.

The launcher does not need to own the repository. Launching creates a market; it does not prove endorsement by its maintainers or grant rights to the code or builder fees. New launches use the [85 SOL liquidity profile](LIQUIDITY.md). The first-buy cap applies only to the purchase bundled into launch.

## Buy and sell

Open a market from Explore, a direct market link, or your wallet holdings. Check the repository and use the copy control to verify the full token mint address.

- **Buy:** enter SOL or use a preset. The panel shows your SOL balance, estimated token output, included trading fee, and price impact.
- **Sell:** enter a token amount or select **25%**, **50%**, or **MAX** of your current token balance.
- Review **Estimated receive** and the minimum after the current fixed **1% slippage** allowance. The quote is refreshed before wallet confirmation.
- Approve in your wallet, then follow the result card. Pending, confirmed, and failed states are separate; the card links to the transaction and supports checking an unresolved status.

Slippage allowance and price impact describe different things. Slippage sets a minimum output relative to the quote; price impact describes how the proposed trade moves its execution price relative to the pool's spot price. A 1% slippage setting does not limit a large trade's price impact to 1%.

For a graduated market, use **Continue on Meteora** once repo.ing has verified its destination pool. Review the quote and fees there. The native price chart includes DBC history and verified DAMM swap prices. Verified DAMM volume is included in the chart’s total volume, graduated-market status, and protocol analytics; graduated execution takes place on Meteora.

## Claim builder fees

Builder fees accrue before a repository owner connects. To claim, you need current **admin** permission on that public repository and control of the payout wallet.

1. Open the market's claim page or the [Builders dashboard](https://repo.ing/builders).
2. Connect GitHub. If required, install or grant the repo.ing GitHub App access to the selected repository. For an organization, its administrator may need to approve that access.
3. Verify the account with current admin permission. Write or maintain permission alone is insufficient.
4. Connect your payout wallet and sign the wallet-binding message. The message binds your GitHub identity, repository, wallet, and expiry; it does not spend SOL.
5. Review the available amount and saved recipient, then select Claim.
6. Wait for the claim receipt. The protected platform signer submits the builder payout after the authorization checks; the claim click does not require a separate user-wallet transfer signature.

GitHub's authorization screen describes the App acting on your behalf because repo.ing needs to identify you and check your access. The configured repository permission is **Metadata: read**. The claim flow does not request code-write or repository-administration permission. The application rechecks current authority before binding or paying; a past login is insufficient. [Verification details](GITHUB_VERIFICATION.md).

### Claim from several repositories

The Builders dashboard lists matching tokenized repositories where your account has current admin access. For repositories without a payout wallet, **Set wallet** can bind the same wallet with one message covering up to 100 repositories. Existing saved wallets must be changed individually.

Review the ready total and each saved recipient, then select **Claim all ready fees**. The site submits a small queue of separate claims and shows a receipt or issue for each repository. Keep the page open while it submits the queue. A partial failure does not undo completed payouts; check the displayed results before starting again.

### Earnings after a claim

| Label | Meaning |
| --- | --- |
| Lifetime earned / repository earnings | All verified builder fees earned, including amounts already paid |
| Available / claimable | Verified earnings remaining after settled payouts, subject to current checks |
| Paid | Builder fees with settled payout receipts |
| Unclaimed | No beneficiary has been bound; fees can still accrue |
| USD estimate | The SOL amount converted at the displayed/current SOL price |

Claiming reduces the available balance and increases paid totals. Lifetime earnings remain. Rent refunds and network costs are accounted for separately from earned fees.

## Claim the builder token allocation

New enrolled markets reserve **1% of supply (10 million tokens)** for the verified repository builder. It becomes available only after successful, verified graduation. Confirm the saved payout wallet, review the one-time allocation, and follow its receipt. Historical markets may not be enrolled; the market shows its own terms. An allocation paid once cannot be claimed again after a wallet or ownership change.

Builder SOL fees remain separate and can be claimed before graduation. [Allocation rules](BUILDER_ALLOCATION_PLAN.md). Builder Reinvest is prepared but remains disabled until the first verified P3 mainnet liquidity deployment; normal fee claims remain available.

## Claim discovery rewards

An eligible market's original launch wallet earns half of actual partner DBC fees until curve completion, 30 days, or its stored lifetime cap (**2.5 SOL for new v2 markets; 1 SOL for earlier v1 markets**), whichever comes first. Existing markets were not retroactively enrolled. Reward details appear on eligible market and wallet views.

Connect the original launch wallet, review the available reward and transaction costs, select **Claim discovery rewards**, and sign the prepared transaction. This payout uses your wallet signature and the platform partner signature. GitHub ownership is not required. Your wallet pays network and account costs, so a small reward may cost more to claim than it pays.

Already-earned rewards remain claimable after the earning window closes. Discovery payouts are separate from builder earnings and do not reduce their share. [Full rules](DISCOVERY_REWARDS.md).

## Understand the numbers

- **Market cap:** current token price multiplied by total supply, converted to USD when a SOL price is available. It is a fully diluted estimate; it does not show cash available for withdrawals.
- **24h volume:** indexed SOL turnover over the last 24 hours. The DBC chart and market-list column use curve trades; graduated-market status and protocol analytics also include verified DAMM trades. Volume is not current liquidity reserve.
- **Holders:** unique token-account owners with positive balances, excluding the canonical DBC token vault. Addresses do not necessarily correspond to distinct people.
- **Graduation progress:** real quote reserve relative to that market's configured threshold. Sells can lower it.
- **Paid to builders:** settled builder payouts. Discovery rewards are separate.

Finalized indexing and short display caches can cause a delay after a trade. An unavailable value is not proof of a zero balance. DAMM prices require canonical migration proof and finalized swap evidence; prices with missing evidence remain withheld. See the verified pool link for graduated trading.

## Common questions

| What you see | What to do |
| --- | --- |
| GitHub connected, repository unavailable | Confirm the correct account, current admin permission, and App access to that repository. Organization policy may require approval. |
| Beneficiary bound, fee state unavailable or needs review | The wallet is saved, but reconciliation or chain evidence is not ready. Wait or refresh; binding alone does not authorize a payout. |
| Claims paused because the signer needs SOL | The operator must fund the protected signer for transaction costs. Accrued pool fees remain in place. |
| Transaction pending | Use the receipt or Check status control. An unresolved transaction may still settle. |
| Quote or balance unavailable | Check the wallet/network connection and retry. The site requires a current quote for the trade review. |
| Wallet disconnected | Unlock the wallet and reconnect; confirm the selected wallet address. |

The market page also provides sharing, owner invitations, and a copyable builder-earnings README badge. Watchlists and optional in-page price alerts are stored in this browser; they do not sync across devices or send background notifications.

## Optional earnings reminders

When email delivery is configured, signed-in builders with a saved payout wallet can enable **Earnings reminders** from Builders. Enter an email and confirm it using the email link within 24 hours. Requests never subscribe someone automatically.

The digest is sent at most once per day, when at least 0.05 SOL is available and at least 0.05 SOL of additional earnings has been verified since the last reminder. Unchanged balances do not generate repeated reminders. The email links to the ordinary review-and-claim flow; it does not authorize a payout. Turn reminders off in Builders or through the email’s unsubscribe link.

Delivery is disabled until a verified sender is configured. [Operator setup and data retention](BUILDER_REMINDERS.md).
