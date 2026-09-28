# Buyback and reserve audit — September 28, 2026

Checked at approximately 14:00 UTC. These are historical observations, not continuously refreshed balances.

## What the site counted

The existing counter read only settled `buyback_intents`. It reported zero protocol-recorded purchases and zero protocol-recorded spend, with `REPO_BUYBACK_EXECUTION_ENABLED=false`. It did not account for manual wallet purchases. That narrow count was correct; the unqualified “Completed buybacks” and inactive wording was ambiguous.

## Verified official-token purchases

Wallet: `4euCWuZo1Ud3PfhFQr9ShmJVzqmARGqY2LR23YECDYce`.
Mint: `59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be`.
Canonical DBC pool: `Gda7Sig9EtVpB7EMVWG1eAAoX8kvq4j68nELsnq3Qfi7`.

Two independent finalized RPCs agreed on each transaction's message, balances, token balances and instruction evidence. Existing canonical swap decoding and indexed trade records matched. The wallet history returned 12 signatures, below the 200-request limit.

SOL below includes trading fees but excludes network fees and launch account deposits. The indexed volume uses canonical swap input after trading fees, so it is not the same as the gross SOL paid below.

| Time | SOL paid | REPOING received | Classification | Evidence |
| --- | ---: | ---: | --- | --- |
| 2026-09-27 17:05:35 UTC | 0.856011397 | 29999999.982493 | Bundled launch purchase | [Receipt](https://explorer.solana.com/tx/3tbwZgaxBHx2DLjHRvtwyy91fCbGKmvT9WQ1riP9QN3FP3KMEiYtQBN3tR9uPpZXUBRQM6QvMJEA3X9zXWKgbkpK) |
| 2026-09-27 17:11:03 UTC | 0.25 | 7870693.633272 | Later wallet purchase; buyback classification pending | [Receipt](https://explorer.solana.com/tx/3U4NMJFgNDuRiSMUydoc4ibMNpwe7zfKj4CcZjAieFiyymM4x2ZPcahTGkXsrAChRhgQbYc6JCmwisg5gb1ip5Vv) |
| 2026-09-27 17:11:36 UTC | 0.1 | 3113424.559373 | Later wallet purchase; buyback classification pending | [Receipt](https://explorer.solana.com/tx/23QNS75cKEEM1vpaBcnrQiSkKSB6E452UxEAx9vDUiM44gfRvZBi6QPxCMuWYAfZ8YvMhE6s9rJ68rY6txVWmVRq) |
| 2026-09-27 22:39:51 UTC | 1.5 | 12408804.843551 | Later wallet purchase; buyback classification pending | [Receipt](https://explorer.solana.com/tx/aDZJpjckNwe537CKSPvaGihm9HjeqUUCpP9UjPa7JFKuwNyySygh1vCVmHnubp2tTMitoDzjBbLYF9q2g7rCtmR) |
| 2026-09-28 00:58:27 UTC | 0.4 | 3872583.786447 | Later wallet purchase; buyback classification pending | [Receipt](https://explorer.solana.com/tx/539hWepPqppnXDeWVzcief83jizi7RFgzap2opdJHxAmESvUjHbB5xX9jdNUfQUNNGfunYeUKr83HdhUQrLWZtVL) |

The four post-launch purchases total **2.25 SOL** and **27,265,506.822643 REPOING**. The last two alone total **1.9 SOL** and **16,281,388.629998 REPOING**, with 0.00001 SOL in network fees. These are acquisition totals, not current holdings or burned supply. Which purchases the operator designates as manual buybacks, and their funding category, remain unconfirmed. No manual receipt was inserted into the protocol execution ledger and no reserve was deducted.

## Custody discrepancy

- Settled platform claims: **0.187668768 SOL**.
- Recorded buyback allocation: **0.112601254 SOL**.
- Recorded liquidity allocation: **0.037533745 SOL**.
- Historical treasury allocation: **0.037533769 SOL**.
- Remaining buyback plus liquidity commitments: **0.150134999 SOL**.
- Independent finalized reads agreed that the recorded receiver `FgzeYRRJLwd3aZQFBgn3a5KnN4mZixSRB9keYzoBm5Jy` held **0.006990122 SOL**.
- Difference against those reserved allocations: **0.143144877 SOL**.

At September 27, 14:58:09 UTC, the receiver transferred **0.18067 SOL** to `FqWpNzjZyNRkWEsAd7bkLMgKYKPf6XLqb448z1MNhhLA`, with a **0.000008646 SOL** network fee. [Finalized transfer](https://explorer.solana.com/tx/4L6c1xyNMnBjCVHhMedTs3UbXEwwt471nKGR8YGzPH3NyuK4dTAtn9vuCWaZHdkYknfm4MtDCyUi3U37rBf3Q1CJ). Both RPCs agreed on this receipt. The transfer predates the official token's launch and is not itself a REPOING swap.

The destination's ownership, purpose and treatment in reserve accounting require operator confirmation. A transfer is not evidence that these funds have been lost or spent on a buyback. The current receiving wallet alone does not cover the recorded reserve obligations.

## Correction

Stats now distinguishes ledger entries from wallet coverage, describes the counter as protocol-recorded buybacks, and identifies external manual purchases as excluded. Buyback and liquidity values are labeled recorded allocations. A separate bounded, dual-RPC mainnet check displays insufficient receiving-wallet coverage or unavailable verification. It never silently changes ledger entries or treats another wallet's funds as reserve backing.

Execution gates, claims, revenue policy and all financial state are unchanged. Manual-buyback classification and any accounting for the external transfer remain pending.
