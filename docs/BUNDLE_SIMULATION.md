# Bundle launch simulation (2026-10-06)

What Bundle launches ([BUNDLE_LAUNCH.md](BUNDLE_LAUNCH.md)) would have done on repo.ing's real markets: each SOL market's public
curve trades, replayed as SOL flows on a bundle market launched at the same time, for raises of 5, 10, 20 and 40 SOL.

## Method

- **Data** (`scripts/bundle-sim/export.mjs`, read-only): `trade_events` of the 53 SOL markets, 2026-09-24 to 2026-10-06, 1,818 curve
  trades (pool, time, direction, amounts; no wallets). The launch transaction's own buy is left out: in a bundle the vault buys there.
  $REPOING is left out (repo.ing's own token; its 11,773 DAMM v2 trades are not curve trades).
- **Engine** (`scripts/bundle-sim/engine.mjs`): Meteora's own quote math (DBC SDK 1.5.13 `swapQuoteExactIn` / `swapQuoteExactOut`) on
  a pool state kept offline, for the launch-fee config bundle markets use (85 SOL, 1.75% after a 180 s launch fee).
  `scripts/bundle-sim/validate.mjs` replays every recorded trade: **1,181 of 1,818 reproduce the recorded on-chain price exactly**
  (±1e-9), all trades of 24 markets; the others are older markets on earlier curve configs. A recorded buy input is the amount after
  the fee.
- **Bundle market** (`scripts/bundle-sim/simulate.mjs`): the vault buys with the raise less 5% at launch (minimum fee). Public buys
  replay as the gross SOL paid; public sells as the SOL received, capped at what the public holds. A vault agent with the default
  policy (2% per trade, 10% of SOL bought / 1% of tokens sold a day, never below cost, 10 minutes between a buy and a sell, nothing in
  the first 180 s) sells above 1.5× its cost and buys after a 15% fall from the 24 h high. Partner fees: the vault's own back to it,
  then 80% backers / 20% repo.ing. **Baseline**: the same flows on the same curve with the real launcher's first buy and no vault.
- **Exit value**: the vault's SOL plus what all its tokens would fetch sold into the curve at the end (not their spot value).

## Results (52 markets, 533 SOL of public curve volume; median market traded 0.8 days, longest 7.2)

| Raise | Vault share of supply | Backer income, median market | Best market (RCAT) | Markets paying backers ≥ 1% of the raise | Vault exit value / its buy (median) | Builder fees, all markets (baseline 28.1 SOL) | Public net SOL (baseline −52.0) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5 SOL | ~15% | 0.017 SOL (0.34%) | 3.8 SOL (76%) | 21 of 52 | 0.965 | 29.9 SOL | −64.1 |
| 10 SOL | ~26% | 0.017 SOL (0.17%) | 3.8 SOL (38%) | 16 of 52 | 0.965 | 32.3 SOL | −64.1 |
| 20 SOL | ~42% | 0.017 SOL (0.08%) | 3.8 SOL (19%) | 7 of 52 | 0.965 | 37.5 SOL | −64.2 |
| 40 SOL | ~60% | 0.017 SOL (0.04%) | 3.8 SOL (9.5%) | 5 of 52 | 0.965 | 47.9 SOL | −64.4 |

- **Backer income does not grow with the raise**: it is 80% of the partner share of *public* volume, which the raise does not
  change. A bigger raise only divides the same income among more SOL.
- **Most backers would not earn their SOL back at today's volume.** Over this window the median bundle pays its backers about
  0.017 SOL; one market in 52 (RCAT, 196 SOL of public volume) pays 3.8 SOL. A raise breaks even at about 308 × its size in public
  curve volume (1 / 0.3248%).
- **The vault holds its value** (median exit 0.965 of its buy: about the fees of getting in and out) and rarely trades (40–105 trades
  across all markets). It cannot be withdrawn, so this value never reaches backers.
- **Builders earn more**, mostly from the vault's launch buy (0.994% of it).
- **Public buyers do worse**: they buy after the vault at higher prices, about 12 SOL more net loss and 8 SOL less held value across
  the 52 markets.
- **No market graduates** in either case: the vault's head start (up to 38 SOL of the 85) is not enough at this demand.

## What it suggests

- Small raises: 1–10 SOL for v1 (5 SOL as the default). They give backers the best return per SOL and leave the public the most room.
- The raise page shows backers the expected range plainly: income is a share of public trading fees, most bundles earn little, and
  the vault's SOL is never paid out.
- Data limits: 12 days of a young platform; bundle markets could draw different demand than these markets did.

## Running it again

```sh
# export (read-only, on the web service; see the comment in export.mjs) to trades.json, then:
node scripts/bundle-sim/validate.mjs trades.json
node scripts/bundle-sim/simulate.mjs trades.json
```
