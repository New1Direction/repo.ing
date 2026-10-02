# Initial-buy review and graduation rehearsal — 2026-09-25

## Launch changes

The default is **No buy**. Optional **1%**, **2%**, and **Max 3%** presets quote the existing production curve. Custom SOL amounts remain supported. The server chooses the largest whole-lamport input whose SDK output does not exceed the selected percentage. The existing 3% launch-only guard remains enforced; this is not a limit on later purchases.

Finalized mainnet config `D7oz8xQ4seaNaEgiDS4fu3YJfmUvR5iPuznxuqKV4u1c` quoted:

| Preset | Buy lamports | Output token base units | Included trading fee lamports |
| --- | ---: | ---: | ---: |
| 1% | 10,230,452 | 9,999,999,678,900 | 179,033 |
| 2% | 20,566,657 | 19,999,999,664,458 | 359,917 |
| Max 3% | 31,010,262 | 29,999,999,539,776 | 542,680 |

Token decimals are six. The first buy and pool creation remain a single transaction. No curve, supply, fee, signer custody, migration, or existing-market setting changed.

**Review launch** prepares and simulates the transaction before asking for a wallet signature. The review separates the initial buy (including its trading fee), net launch account deposits, network fee, and estimated total SOL debit. The connected SOL balance is visible. Failed simulation, missing cost evidence, or insufficient funds prevents approval. Fields lock during review; editing cancels the unsigned session, and a wallet change invalidates the review. Reviews expire and can be refreshed. No-buy and a custom zero amount both mean no swap.

Unsigned mainnet simulation of a no-buy launch returned a 15,000-lamport network fee, 20,581,640 lamports of account deposits, and a total of 20,596,640 lamports. These are estimates at the checked state, not hard-coded prices. The then-current wallet balance of 34,078,750 lamports was insufficient for Max 3% plus setup, and simulation correctly blocked it. No mainnet launch was sent.

### Priority fee (2026-10-01)

Launches used to set a 1.4M compute-unit limit at price 0, so they could stall behind priority traffic. The reviewed message now carries a priced budget, set once before review (`src/launch-wallet-fees.mjs`):

- **Limit:** a zero-price probe of the same message is simulated; the limit is the units consumed × 1.2, at least +40k for wallet-appended Lighthouse assertions (floor 100k, ceiling 1.4M; 400k if the probe fails). Local-validator launches consume about 100k units without a first buy and 160-200k with one.
- **Price:** the trades' estimate (`src/trade-landing.mjs`): the p75 of recent non-zero prioritization fees on the launch's writable accounts (Helius's `High` estimate on Helius), clamped to 200,000-2,000,000 microlamports per unit, 500,000 if unavailable.
- **Cap:** limit × price never exceeds 1,000,000 lamports (0.001 SOL), the trades' cap; above a 500k limit the price is lowered to fit.
- **Review:** `getFeeForMessage` and the simulated wallet debit both include the priority fee. The network-fee line shows it ("Includes … priority fee") and must cover one base fee per signature plus that fee, otherwise the review is refused. The total is still exactly the wallet debit.

## Verification

- Four focused cost/evidence tests passed: integer arithmetic, no double-counted trading fee, and missing/unsafe/contradictory simulation evidence.
- Updated local atomic-launch test passed: all percentage boundaries, one lamport above Max rejection, exact first-buy token output, finalized chart event, and **simulated total exactly equal to actual wallet debit**. Network fee matched the finalized transaction.
- Browser checks used a separate localhost database and a Local QA wallet that cannot sign. Max quoted 3.00%, the review showed buy/deposits/fee/total, edit released the unsigned session, no-buy review worked, and changing the wallet cleared approval. At 390px the document width was 390px. No production repository was reserved or launched for these checks.
- Production build and `git diff --check` passed. Railway web deployment `41fa8bdc-b3d2-4dc9-82ac-8bb01d05bb68` succeeded. The live launch page returned HTTP 200 with the presets and review button; all three live preset quotes returned HTTP 200 and the exact amounts above.

## Graduation and claims

The local Meteora rehearsal now uses the production **175 bps / 71%** settings. Its finishing buy uses supported partial fill instead of an obsolete 1% fee gross-up. It verified actual DAMM v2 migration, the creator-owned position, approximately 50/50 permanently locked liquidity, withdrawal of remaining DBC builder fees, a DAMM buy, and a DAMM builder-fee payout to a separate receiver. Integer liquidity conversion leaves one raw liquidity unit unlocked in the creator position; the config's withdrawable allocation remains zero.

Local evidence (not mainnet receipts):

- Config: `DSutYUMYEvjtgwHNX72G1956AMVUbKxZLfvq8Na22RQx`.
- DBC pool: `AMueyDN6h2voRUqyaQ8pAzykdMeRzeQvLxToEFSCrDkZ`.
- DAMM pool: `EqRSPxEXAiS3aY5KmNaLF7E4MDMWspp6pv56JNRR8una`.
- Migration: `473UXyNAPxKj653JUPhHc6bQBJg7ZRBTmZhUoKdiWrsBKbm8uyKCnjYZJDRwjt3JbLiMeEiC6m11McdnSXjuk4ZV`.
- Remaining DBC fee payout: `3bJEd8dnyCR6BDkkWgpB7NRF4UabdhZ8VU1U3ipqsiNUQohPXHkpktYPP3xa7uedQq1GcXAu9Hw5dZNfgtC4NTSQ`; 301,233,654 fee lamports plus a separate 2,039,280-lamport temporary-account rent refund.
- DAMM buy: `2jaWrFZ83Krnfq2BZd3Wm66cw5mP67jkKqzAtWH5hYparrqypWi5oSJWj5tMNkTsGmpDG5kEu8a5uMs61xq8GUCp`.
- DAMM builder claim: `5ukHRdqRUGkbXXybcicrEbLzbz4apT6igRedSDL1sWYpKQmnXBW6FKEZytiLpvSkoMvfqcjVjY3exyFQia3agZwe`; 400,000 fee lamports plus the separate rent refund. Receiver delta matched exactly.

The discovery integration was extended through **actual migration**, not only curve completion. Nine tests passed, including authorization, immutable offer handling, lost-broadcast recovery, one settlement, untouched builder fees, duplicate rejection, canonical graduated-pool URL verification, and payout of previously earned discovery fees after migration. Total earned and paid were 61,891,237 local-test lamports.

- Local discovery DBC pool: `BQgzEDTbSEjaPNJsekC9Ain33V1yBV7SHuK4kFWRKnae`.
- Migration: `43qLqFkz6mMRRyhWAHaSwV5Q2C8uAb5dDQWrmNiJM33878n8cbFGVYoN9MtyY6TYjeBKyf2Exp9KiGqWAiJWm7K7`.
- Verified DAMM destination: `FGRoPUCq4eG87k29RwkoXZKvP72wMKzSNyvPZFCnixvh`.
- Recovered discovery payout: `5TCA56sSB2q9LTzVcMbgtMfvHEfK5pMvD5rdrctahUZ35CqQYMzDK2YAjRVq7FfqDeyrEoBkiLgc9Kq6uwSY8uaM`.
- Post-migration discovery payout: `52SoLk9snCv9XBNVmJTFp56nvrqhF5LKj1yjaqTQUWSsTFnUWBFtNtkTe9fGWk3QspM2mzHidxFxneveR3WkRkDo`.

## Production boundaries

**Updated by the subsequent rollout:** Production now includes canonical DAMM creator-position verification, finalized SOL fee checkpoints, current GitHub authority and bound-recipient payouts, and durable payout recovery. See [graduated builder fees](GRADUATED_FEES.md) and [activation evidence](LIQUIDITY_REVIEW.md). The migrated pool has different fee economics; the 0.994% DBC builder rate does not continue after graduation. First mainnet graduation and graduated payout still require actual mainnet receipts.

No production graduation was forced. At the read-only check, the enrolled pools had roughly 0.0295 SOL and 0.0489 SOL in quote reserves versus a 29.954748784 SOL threshold. Buying enough to force migration would use real funds and change live market prices; it needs a separate reviewed transaction.

The first real discovery payout was subsequently signed by the launcher and verified at finalized slot `450444046`: SKILLS paid 379,639 lamports, the network fee was 15,000 lamports, and the recipient's net wallet gain was 364,639 lamports. The production ledger records one settled claim and zero remaining rewards; two earlier unsigned offers are aborted. See [mainnet discovery receipt and ledger evidence](DISCOVERY_REWARDS.md#first-mainnet-discovery-payout).

References: [Solana simulation](https://solana.com/docs/rpc/http/simulatetransaction), [Meteora migration flow](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/main/packages/dynamic-bonding-curve/README.md).
