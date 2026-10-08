# Using repo.ing

[Documentation](README.md) / User guide

## Find a market or repository

[Explore](https://repo.ing/explore) opens with the **Graduation race**, then **All markets**, followed by new markets, markets closest to graduation, builder earners, and discoverers. The separate **Find repos** tab shows public repositories gaining attention, with source evidence. Selecting a candidate opens the existing repository review and launch flow; nothing launches automatically.

On **Find repos**, search names/descriptions, choose **No market yet** or **Live markets**, and narrow by **Gaining stars** or **Recent releases**. Searches cover fresh tracked candidates, not all of GitHub. Pasting a GitHub repository URL uses the ordinary repository resolver and opens its market or launch form. An approved trend candidate keeps its **Review & launch** action. Scores still expand into the original source evidence. Optional natural-language matching requires the server-side TypeSafe integration; ordinary search and filters remain available without it.

[Stats](https://repo.ing/stats) shows protocol activity, settled builder payouts, and platform reserves. [Metric definitions](ANALYTICS.md) explain the periods and accounting.

## Connect a wallet

Select **Connect wallet**, then choose an available Solana wallet. repo.ing supports Phantom, Backpack, MetaMask's Solana connection, and compatible Solana Wallet Standard wallets that provide the required transaction and message signing features.

The site remembers the selected wallet in this browser and attempts to restore an authorized connection when you return. Your wallet may still require unlocking or reconnection. The wallet menu lets you copy your address, view holdings, switch wallets, or disconnect. repo.ing never asks you to enter a seed phrase.

Keep some SOL available for transaction fees and token-account costs. The Buy panel shows the connected wallet's SOL balance; spending the entire displayed balance may leave insufficient SOL for those costs.

## Read a market chart

Choose **1H**, **24H**, **7D**, or **All**; switch between **Candles** and **Line**, or **Price** in SOL and **MCap** in estimated USD. Hover or touch the chart for price and volume details. Drag to pan, pinch to zoom, or use the zoom/reset buttons. Keyboard users can focus the chart and press `+`, `-`, or `Home`. **Chart details & data** contains a readable price table.

Prices come from finalized pool swaps. Empty periods stay empty, and a delayed update is labeled. USD values use today’s SOL price. After verified graduation, the chart continues with finalized swaps from that repository’s canonical DAMM pool. Until its first indexed DAMM price, the curve history is labeled clearly. The same Buy/Sell panel trades the verified DAMM pool, and **View pool** opens it on Meteora. [Data definitions](CHARTS_AND_RESPONSIVENESS.md).

## Launch a repository market

### Understand graduation progress

Each market's Graduation Progress shows finalized SOL reserves against that market's on-chain target. Buys add SOL after trading fees; sells reduce reserves and progress. Trading volume counts activity in both directions, while graduation requires SOL to remain in the curve. The displayed remaining reserve is not an executable purchase quote. Once the target is reached, the site waits for verified migration before linking the same token's DAMM pool.

The official $REPOING market and Stats also show every $REPOING Jupiter Lock escrow (team deposits and bought-back tokens): original deposits, share of fixed supply, exact UTC release schedules, each lock's fixed creator and recipient wallet, and source links. These are separate from the builder allocation and do not represent all team or buyback-wallet holdings. Read [the verified lock disclosure](REPO_IDENTITY.md#token-locks); Jupiter shows current claim status.

### Launch steps

1. Paste a public GitHub repository URL into [repo.ing](https://repo.ing). Private and archived repositories are not eligible.
2. If the repository already has a canonical market, open that market. A rename does not create a new repository identity.
3. Review the repository, token name, ticker, and suggested image. Use **Change image** to choose another project logo or owner avatar, or **Upload image** for your own PNG, JPEG, WebP, or GIF up to 2 MB. The preview fits the full image without cropping; the selected artwork is saved at launch. [Image details](TOKEN_IMAGES.md).
4. Choose **No buy**, a 1% or 2% preset, or **Max 3%** for the optional first purchase. The percentage refers to total token supply.
5. Review the simulated launch cost and allocation, then approve the transaction in your wallet. The network fee includes a small priority fee (at most 0.001 SOL) so the launch lands when Solana is busy; the review total is exactly what your wallet pays.
6. Wait for confirmation and open the market from the success card. If the transaction is pending, check its receipt before submitting another launch.
7. Use the **Launch kit** on the success card: **Post on X** (prefilled with the ticker, repository and market link), **Copy README badge**, **Copy link**, and, while no maintainer has verified the repository, **Invite the maintainer**.

The launcher does not need to own the repository. Launching creates a market; it does not prove endorsement by its maintainers or grant rights to the code or builder fees. New launches use the [85 SOL liquidity profile](LIQUIDITY.md). The first-buy cap applies only to the purchase bundled into launch.

## Buy and sell

Open a market from Explore, a direct market link, or your wallet holdings. Check the repository and use the copy control to verify the full token mint address.

- **Buy:** enter SOL or use a preset. Use the pencil button to edit the three amounts, saved on this device. Selecting a preset only requests a quote; it does not submit a trade. The pay field shows your SOL balance and the amount in dollars, the receive field the estimated tokens, and the list below it the minimum received, price impact and included trading fee. The arrow between the fields switches between buying and selling.
- **Sell:** enter a token amount or select **25%**, **50%**, or **MAX** of your current token balance.
- Review **You receive** and **Minimum received**, which your **max slippage** sets: 1% unless you choose 3%, 5%, 10%, 20% or a custom 0.5–25% under **Max slippage** (remembered on this device). The quote is refreshed before wallet confirmation. The trade button says what is missing (an amount, or enough SOL or tokens) until the trade can be made.
- If your wallet has linked an X account (**Connect X** on your wallet page), the panel shows **Buying as @handle** and your trades show that handle in the market's **Recent trades** and **Activity** instead of your address.
- If the price moves past your limit before the trade lands, it is stopped: nothing is spent if it was never sent, only the network fee if Solana rejected it. The result card offers a one-tap retry at the next preset up.
- With a connected wallet, review the network fee, token account deposit, total cost, and any temporary SOL deposit. Temporary wrapped-SOL rent is returned in the same transaction but is required up front. If your balance is short, the panel shows how much more SOL is needed. The prepared transaction is simulated before wallet approval.
- Approve in your wallet, then follow the result card. Pending, confirmed, and failed states are separate; the card links to the transaction and supports checking an unresolved status.

Slippage allowance and price impact describe different things. Slippage sets a minimum output relative to the quote; price impact describes how the proposed trade moves its execution price relative to the pool's spot price. A 1% slippage setting does not limit a large trade's price impact to 1%.

For a graduated market, the same Buy/Sell panel trades in the repository’s verified Meteora DAMM v2 pool once repo.ing has verified the destination from the curve’s finalized migration. Quotes, the max-slippage minimum, fees and network costs are shown the same way, your wallet signs the exact swap, and the receipt is checked against the canonical pool before it is shown as confirmed. **View pool** under the trade button opens the pool on Meteora. The native price chart includes DBC history and verified DAMM swap prices, which appear once the DAMM trade indexer records the finalized swap.

## Claim builder fees

Builder fees accrue before a repository owner connects. To claim, you need current **admin** permission on that public repository and a Solana wallet you control to receive the payout. You don't need a wallet browser extension: you can paste the wallet's address instead (it starts receiving payouts after a 48-hour hold).

1. Open the market's claim page or the [Builders dashboard](https://repo.ing/builders).
2. Connect GitHub. If required, install or grant the repo.ing GitHub App access to the selected repository. For an organization, its administrator may need to approve that access.
3. Verify the account with current admin permission. Write or maintain permission alone is insufficient.
4. Set the payout address: either connect your payout wallet and sign the wallet-binding message (it takes effect at once; the message binds your GitHub identity, repository, wallet, and expiry and does not spend SOL), or [paste the address](#paste-a-payout-address) (it takes effect after 48 hours).
5. Review the available amount and saved recipient, then select Claim.
6. Wait for the claim receipt. The protected platform signer submits the builder payout after the authorization checks; the claim click does not require a separate user-wallet transfer signature.

GitHub's authorization screen describes the App acting on your behalf because repo.ing needs to identify you and check your access. The configured repository permission is **Metadata: read**. The claim flow does not request code-write or repository-administration permission. The application rechecks current authority before binding or paying; a past login is insufficient. [Verification details](GITHUB_VERIFICATION.md).

### Paste a payout address

If you don't have a Solana wallet extension, select **No Solana wallet extension? Paste a payout address instead** on the claim page (or **Paste an address** on a Builders dashboard row). Copy your SOL receiving address from any Solana wallet app, paste it, and type its **last 4 characters** as your wallet app shows them, so a wrong paste is caught. Use a Solana wallet you control. Exchange deposit addresses may not credit program payouts.

- **A 48-hour hold.** A pasted address can receive payouts 48 hours after you save it. The page shows **Pasted address, active from &lt;date&gt; (cancel)** with a countdown. If the repository already has a payout address, that address keeps receiving claims until then; if not, claims open when the pasted address becomes active.
- **Anyone with admin access can cancel it** during the hold: every current admin of the repository sees the waiting address and a **cancel** link (a fresh GitHub admin check, as for every change). Pasting a different address replaces the waiting one and restarts the hold. Signing with a wallet replaces a waiting address at once.
- **Checked before it is saved.** repo.ing accepts only a Solana wallet address: it refuses program and system addresses, program-derived addresses, and any address that holds a token account, mint, program or other program data on Solana. If Solana can't be reached for that check, nothing is saved; try again.
- **Email notice.** If you turned on earnings reminders, you receive **Payout address change requested** right away when an address is pasted for a repository you set up, and so does the person who pasted it.
- After the hold, the claim page shows **Pasted address, active since &lt;date&gt;**; a wallet-signed address shows **Verified by wallet signature**. Claim reviews always show the exact address that will be paid. To change a pasted address later, sign with a wallet (immediate) or paste another (another 48-hour hold).

A pasted address shows that a repository admin chose it, not who holds it. So a market launched from the payout wallet counts as **Official** only when that wallet was set by signing (see [Understand the numbers](#understand-the-numbers)), and the maintainer's ✓ X handle and the **Builder** label in Backers also come only from a wallet-signed payout address.

### Claim from several repositories

The Builders dashboard lists matching tokenized repositories where your account has current admin access. For repositories without a payout wallet, **Set wallet** can bind the same wallet with one message covering up to 100 repositories, or **Paste one address** sets the same pasted address for all of them, each with its own 48-hour hold. Existing saved wallets must be changed individually.

Review the ready total and each saved recipient, then select **Claim all ready fees**. The site submits a small queue of separate claims and shows a receipt or issue for each repository. Keep the page open while it submits the queue. A partial failure does not undo completed payouts; check the displayed results before starting again.

After a payout, **Share your payout** opens an X post with the exact amount paid, the repository and its market link (on the claim page and on each paid dashboard row).

### Sponsor button and live building streams

On the claim page (once the repository is verified) and under **Sponsor button & live stream** on each dashboard row, copy the `.github/FUNDING.yml` line `custom: ["https://repo.ing/token/<mint>"]`. Committing it puts repo.ing on the repository's GitHub Sponsor button.

A verified admin can also link where the build is streamed: an https link on YouTube, Twitch, X or Kick. The market page then shows a **Building live** card with a **Watch** link (it never embeds the stream). Switch on **Live now** to show a LIVE badge; it turns itself off after six hours. Every change rechecks your current GitHub admin access.

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

Connect the original launch wallet, select **Claim**, review the reward, and select **Sign message to claim**. Your wallet signs a short message confirming the claim; it never signs a transaction. repo.ing then sends the reward to your wallet and pays the network fee, so you receive the full amount. GitHub ownership is not required. Rewards below 0.002 SOL stay accrued until more fees arrive.

Already-earned rewards remain claimable after the earning window closes. Discovery payouts are separate from builder earnings and do not reduce their share. [Full rules](DISCOVERY_REWARDS.md).

## Understand the numbers

- **Market cap:** current token price multiplied by total supply, converted to USD when a SOL price is available. It is a fully diluted estimate; it does not show cash available for withdrawals.
- **24h volume:** indexed SOL turnover over the last 24 hours: bonding-curve trades and, after graduation, trades in the market's verified DAMM v2 pool (market lists, token pages and protocol analytics alike). Volume is not current liquidity reserve.
- **Holders:** unique token-account owners with positive balances, excluding the canonical DBC token vault. Addresses do not necessarily correspond to distinct people.
- **Graduation progress:** real quote reserve relative to that market's configured threshold. Sells can lower it.
- **Paid to builders:** settled builder payouts. Discovery rewards are separate. Stats splits paid and earned amounts between outside builders and the repo.ing team's own repositories.
- **New repo:** the repository was created on GitHub less than 30 days ago or has fewer than 10 stars. Its market trades like any other and shows in its real place, with the label, on the home page's market tabs, its Shipping list and the graduation race. Until its curve reaches 10% of its graduation target, repo.ing leaves it out of the Live from GitHub ticker, Official launches, the $REPOING page's newest launches and launch posts, and Explore's Trending and Market cap views list it after the other markets. The label goes away once the market reaches that 10% or graduates; the token page's Launch facts keep showing the repository's age and stars.
- **Official:** the repository's verified maintainer launched the market from the payout wallet they set on repo.ing by signing with it (a pasted payout address does not count). Like Verified, it is not an endorsement of the token.
- **Repo score (0–100):** stars (up to 40), forks (up to 15), age (up to 20) and this week's developers and commits from Dev Pulse (up to 25), in the token page's Launch facts.

Finalized indexing and short display caches can cause a delay after a trade. An unavailable value is not proof of a zero balance. DAMM prices require canonical migration proof and finalized swap evidence; prices with missing evidence remain withheld. Graduated markets trade in the verified DAMM pool through the same Buy/Sell panel.

## Common questions

| What you see | What to do |
| --- | --- |
| GitHub connected, repository unavailable | Confirm the correct account, current admin permission, and App access to that repository. Organization policy may require approval. |
| Beneficiary bound, fee state unavailable or needs review | The wallet is saved, but reconciliation or chain evidence is not ready. Wait or refresh; binding alone does not authorize a payout. |
| Pasted address waiting | It becomes the payout address when the 48-hour hold ends (see the countdown). Until then any previous payout address keeps receiving claims; with none, claims open then. Didn't paste it? Any current admin can cancel it on the claim page. |
| Claims paused because the signer needs SOL | The operator must fund the protected signer for transaction costs. Accrued pool fees remain in place. |
| Transaction pending | Use the receipt or Check status control. An unresolved transaction may still settle. |
| Quote or balance unavailable | Check the wallet/network connection and retry. The site requires a current quote for the trade review. |
| Wallet disconnected | Unlock the wallet and reconnect; confirm the selected wallet address. |

The market page also provides sharing, owner invitations, and a copyable builder-earnings README badge. Watchlists and optional in-page price alerts are stored in this browser; they do not sync across devices or send background notifications.

## Optional earnings reminders

When email delivery is configured, signed-in builders with a saved payout wallet can enable **Earnings reminders** from Builders. Enter an email and confirm it using the email link within 24 hours. Requests never subscribe someone automatically.

The digest is sent at most once per day, when at least 0.05 SOL is available and at least 0.05 SOL of additional earnings has been verified since the last reminder. Unchanged balances do not generate repeated reminders. The email links to the ordinary review-and-claim flow; it does not authorize a payout. Turn reminders off in Builders or through the email’s unsubscribe link.

Subscribers also get a **Payout address change requested** notice as soon as someone pastes a new payout address for a repository whose payout address they set (or that they pasted themselves), with the address, when it becomes active, and the claim page where any admin can cancel it.

Delivery is disabled until a verified sender is configured. [Operator setup and data retention](BUILDER_REMINDERS.md).

## Share a market or builder payout

Choose **Share card** on a market to download a 1200 × 630 PNG or copy a caption with the market link. Choose **Graduation progress** for a timestamped reserve/target snapshot, or **Builder payout** for the latest finalized payout. After a successful claim, **Payout card** selects that specific receipt.

Graduation cards require fresh canonical indexed evidence and a reconciliation match. Payout cards recheck the finalized Solana receipt against the settled claim. Unavailable proof shows a retry state instead of an invented number. Cards are snapshots; they do not keep updating after download. Native sharing is available when the browser supports file sharing; otherwise use Download PNG and Copy caption.

### Referrals

[Referrals](https://repo.ing/referrals) gives you a link carrying `?ref=` with your wallet. Once your referral payouts are set up, the market links you share (Copy link, Share on X, the Blink link, share-card captions, and the launch kit's and Share your payout's posts and links) carry it too. A note beside them says so, because the link contains your wallet address, and lets you share without it; that choice is remembered on this device. For 30 days after someone opens your link, their trades on repo.ing name you as referrer (the last link they opened wins); trades from a Blink you shared do too. Each such trade pays you 4% of its trading fee in SOL, carved from Meteora’s protocol share, so traders, builders and repo.ing pay nothing extra. The Referrals page also shows the one-time payout setup (a wrapped-SOL account in your wallet; without it no referral can be paid), your earnings and a public leaderboard of estimated earnings from settled repo.ing trades. For now the setup is free: "Enable payouts (free)" asks your wallet to sign a message, not a transaction, and repo.ing pays the account's deposit and network fee. It is free once per wallet (also if you close the account later) and for up to 50 wallets a day; after that, or if the free setup fails, the button shows the deposit (about 0.0015 SOL, refundable) and you pay it yourself.

### Faster market feedback

Hover or focus a market link to warm its public chart. Open markets refresh after indexed activity arrives, with polling as a fallback. An estimate can appear before the network/account cost preview finishes; both are checked again before you approve the transaction.

[How it works](https://repo.ing/how-it-works) now has three selectable steps: Repository, Market, and Builder paid. The last step links to real settled payout receipts. After a verified launch, your chosen artwork appears in a market card with a direct View market action, copyable address, and transaction receipt.
