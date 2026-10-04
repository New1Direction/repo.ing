# Stock pairs: go-live runbook

The owner's checklist for turning on stock-paired markets, such as DOCUSAURUS / METAx. Do the steps in order. Each step says
what happens on chain and what it costs. How stock pairs work is in [Stock-paired markets](STOCK_QUOTES.md).

Stock pairs ship turned off. Two switches keep them off:

- `STOCK_PAIR_LAUNCHES_READY` in `src/quote-assets.mjs`. It is a line of code. A pull request turns it on.
- `STOCK_QUOTES_ENABLED` on the web service. It is a Railway variable.

Launches open only when both are on. Until then the site offers SOL pairs only.

Nothing here happens by itself. repo.ing's code never creates configs or pools on mainnet and never sends a transaction for
you. Scripts that can send print a dry run first, and send only the exact amounts you approve.

## 1. Legal check

On chain: nothing. Cost: no SOL.

Do this first. Ask a lawyer to look at three things:

- **Who may hold xStocks.** Backed Finance issues METAx, MSFTx and NVDAx. Its terms exclude U.S. persons, UK retail clients
  and sanctioned countries. Stock pairs make people buy and sell these tokens through repo.ing.
- **Company names and logos.** Market pages name the company, its ticker and its stock, for example Meta Platforms, META,
  METAx. Check how these may be used.
- **The issuer's powers.** Backed can pause transfers, freeze accounts, move or burn any balance, and change the display
  multiplier. It can end a product on 30 business days' notice, so stock locked in a pool forever may never be redeemable.
  See [Issuer powers](STOCK_QUOTES.md#issuer-powers).

Go on only with the answer in writing.

## 2. Pick the graduation thresholds

On chain: nothing. Cost: nothing.

A new market trades on a bonding curve. It graduates, moving into a Meteora DAMM v2 pool, once its curve holds a set amount
of its quote. SOL markets graduate at 85 SOL. A stock pair's threshold is a whole number of that stock, for example 14 METAx.

- **In shares.** The threshold counts the stock as the chain does. Wallets show a little more: the chain amount times the
  stock's multiplier, which grows as dividends are reinvested, and that shown amount tracks shares. The METAx multiplier was
  about 1.003 in October 2026, so 14 METAx on chain is about 14.04 shares.
- **In US dollars.** The threshold times the price of one token as the chain counts it. For example, at $712.50 per METAx,
  14 METAx is about $10,000. To match SOL markets, take what 85 SOL is worth that day, divide by that price, and round to a
  whole number.
- **It moves with the stock, not with SOL.** If the stock doubles in price, so does the dollar target.
- **It is fixed.** You set it once per stock, in step 3. It cannot be changed later.

Write down one number for each stock you will open: METAx, MSFTx, NVDAx.

## 3. Create each stock's config

On chain: one Meteora DBC config account per stock. Cost: about 0.006 SOL each, from the partner wallet.

A config is the Meteora settings account that new markets of one pair launch on. It holds no funds, launches nothing and
changes no existing market. It fixes:

- the trading fee: 1.75%, with the same launch-fee window as SOL launches;
- what happens to the fee after Meteora's 20%: 71% to the creator side, 29% to repo.ing's partner side;
- the stock as the quote, through Token-2022;
- who claims the partner side: the platform partner wallet `H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3`;
- graduation into DAMM v2, where all of the pool's liquidity is locked forever, half for each side;
- your threshold from step 2.

**First, a dry run.** It simulates the transaction without signing and prints what it would do. Nothing is sent.

```sh
SOLANA_RPC_URL=<mainnet https RPC> node scripts/create-stock-quote-config.mjs --asset meta-xstock --graduation 14
```

- The first run makes a new address for the config. Its key is saved in `secrets/stock-config-meta-xstock-keypair.json`,
  which Git ignores.
- Without `SOLANA_RPC_URL`, the script reads the production RPC from Railway (you must be logged in). It only reads.
- Read `inPlainWords`, then note `config`, `instructionSha256` and `totalDebitLamports`.

**Then send it**, approving those three values:

```sh
APPROVED_STOCK_CONFIG=<config> APPROVED_STOCK_CONFIG_INSTRUCTION_SHA256=<instructionSha256> \
APPROVED_STOCK_CONFIG_DEBIT_LAMPORTS=<totalDebitLamports> \
SOLANA_RPC_URL=<mainnet https RPC> node scripts/create-stock-quote-config.mjs --asset meta-xstock --graduation 14 --execute
```

- It takes the partner key from the macOS Keychain (`repo.ing.dbc.partner`). It signs one transaction with that key and the
  config's key, and sends it.
- **Who pays:** the partner wallet pays the account's rent and the network fee. The SOL launch-fee config cost 5,984,080
  lamports (0.006 SOL): rent for its 1,048-byte account plus a 10,000-lamport fee. A stock config is the same size. The dry
  run prints the exact amount. The wallet needs that much plus 0.001 SOL.
- It waits until the transaction is final, checks the new account is exactly what was simulated, and prints the
  `STOCK_QUOTE_CONFIGS` value to set.

Repeat for `msft-xstock` and `nvda-xstock`.

**A config can never be edited or closed.** Meteora has no way to do it, and its rent stays in it. If one comes out wrong,
make a new one: move its keypair file out of `secrets/` (or pass `--keypair <new file>`) so the script makes a new address,
and use the new config instead. Do this only before any market launches on the old one. A stock market finds its pool through
the config `STOCK_QUOTE_CONFIGS` names for its stock, so changing that entry later would break the markets already launched.

**Check it** with the readiness script before you set anything on Railway:

```sh
SOLANA_RPC_URL=<mainnet RPC> DBC_CONFIG=8TXNGgx6g5TcsVCYt7wz3cAxJkynzzBZWXeQtXZaz6A3 \
STOCK_QUOTE_CONFIGS='{"meta-xstock":"<config>"}' node scripts/stock-readiness.mjs
```

`DBC_CONFIG` is the live SOL launch config ([Launch fee](LAUNCH_FEE.md)); each stock config must carry its terms. Every
`METAx config` line must say PASS. `METAx config graduation` repeats your threshold in METAx.

## 4. Set STOCK_QUOTE_CONFIGS on web and worker

On chain: nothing. Cost: nothing. Each service restarts; no code is deployed.

Set the same value on **web** and on the **worker**. While launches are closed, the order does not matter:

```text
STOCK_QUOTE_CONFIGS={"meta-xstock":"<config>","msft-xstock":"<config>","nvda-xstock":"<config>"}
```

- Leave out any stock you are not ready for. It stays unavailable.
- Users see no change yet: the switches are still off.
- A value that does not parse breaks stock markets only, never SOL markets. The readiness script reports it.

## 5. Run the readiness script until nothing fails

On chain: reads only. Cost: nothing.

`scripts/stock-readiness.mjs` checks everything this runbook sets up. It never signs or sends, loads no key and writes
nothing. It never prints the RPC or database address. Run it on each service, so it uses that service's own settings and
database:

```sh
railway ssh --service web -- node scripts/stock-readiness.mjs
railway ssh --service worker -- node scripts/stock-readiness.mjs
```

The script is part of the code. If a service does not have it yet, deploy web first (its pre-deploy step applies database
migrations), then the worker.

Each line says PASS, FAIL or TODO, with one reason. Switches say ON or OFF. The script ends with an error if anything fails.

| Section | What it checks |
| --- | --- |
| Network | The RPC is Solana mainnet. |
| Registry | Each stock's pinned mint: Token-2022, 8 decimals, a ScaledUiAmount multiplier that makes sense, usable now (not paused, no transfer hook or transfer fee, accounts not frozen by default), and Meteora's DBC and DAMM v2 badges for it. |
| Stock configs | `STOCK_QUOTE_CONFIGS` parses. For each config: a real DBC config account, quoting the right stock through Token-2022; creator share exactly 71%; fees claimed by the partner wallet; the SOL launch config's terms field by field (fees, fee mode, migration) and the curve the create script builds; the threshold, in the stock. |
| Database | Migration 0054's tables, functions and triggers, migration 0055's read indexes, and migration 0056's execution guards (one collection and one payout per transaction). 0056 comes with fee collection and payout execution: until it is applied, its line is a TODO. Every indexed market is in exactly one of the worker's two lists, SOL or stock. No stock market in any SOL fee, trade, claim or reward table. |
| Custody | Whether the partner wallet already has an account for each stock. Missing is a TODO: it is created on the first collection. |
| Switches | The two launch switches and the two flags of step 9. Off is expected now and is not a failure. |

Done means no FAIL on either service. The only TODOs left should be custody and, until the execution work has merged and
web has deployed it, migration 0056. Both services must show the same `STOCK_QUOTE_CONFIGS` line.

## 6. Turn on launches: the switch PR, then STOCK_QUOTES_ENABLED

On chain: nothing. Cost: nothing.

1. **The switch PR** sets `STOCK_PAIR_LAUNCHES_READY = true` in `src/quote-assets.mjs`. Merge it only after the rest of the
   stock-pair work has merged and step 5 passes. Merging deploys nothing. After merging, deploy web first (its pre-deploy
   step applies database migrations), then the worker. Launches stay closed, because `STOCK_QUOTES_ENABLED` is still off.
2. **Then, on web,** set `STOCK_QUOTES_ENABLED=true`. Web restarts. Repositories owned by the facebook, microsoft and nvidia
   organizations on GitHub can now launch paired with their company's stock, for each stock that has a config in
   `STOCK_QUOTE_CONFIGS`.
3. Run the readiness script on web again. `Stock launches` must say ON, and nothing may fail.

## 7. Your own first test launch

On chain: a new token, its metadata and its curve pool; then one buy and one sell. Cost: about 0.02 SOL for the launch, plus
network fees and a little of the stock for the trades.

1. Use your own wallet. Put a little of the stock in it first, for example 0.5 METAx: stock pairs are bought with the stock.
2. Open the launch page of a repository owned by one of those organizations, and choose its stock pair, for example
   DOCUSAURUS / METAx.
3. Review, then sign. A stock-pair launch has no initial buy. The review shows the SOL your wallet pays before you sign:
   account deposits and the network fee. A SOL launch with no buy came to 0.0206 SOL in a mainnet simulation.
4. Wait at least 3 minutes. For the first 180 seconds a new market charges the launch fee, which starts at about 50% and
   falls to 1.75% ([Launch fee](LAUNCH_FEE.md)).
5. Buy a small amount with the stock, then sell it back. Each trade pays 1.75% in the stock and a network fee in SOL. Your
   first buy may also open your account for the new token, a small SOL deposit.
6. Check that the token page shows the pair and your trades, that the worker has recorded the trades' fees within a few
   minutes, and that the readiness script still passes.

If anything looks wrong, turn launches off (step 11), then look into it.

## 8. How fees flow from then on

On chain: fees stay in each market's pool until they are collected. Cost: nothing to you.

Every trade on a stock pair pays 1.75%, in the stock:

| Who | Share of each trade |
| --- | --- |
| Meteora | 0.35% |
| The launcher | 0.30%, for as long as the market trades, paid in the stock |
| That stock's accumulator | 1.10%: the rest of the creator side (0.694%) and repo.ing's partner side (0.406%) |

- The worker records each trade's fee and its split in the stock ledgers. Nothing goes into the SOL tables.
- No one claims a stock pair's builder fees as owner. A company admin who verifies the repository changes nothing.
- After graduation, the launcher gets the same 150/497 of the creator position's fees. The partner position's fees all go to
  the accumulator.
- There is one accumulator per stock. Every market paired with METAx adds to the METAx accumulator. It is meant to become
  permanent REPOING/METAx liquidity (step 10).

## 9. Later: collecting fees and paying launchers

On chain: once turned on, collections claim fees from the pools into the partner wallet, and payouts send launchers their
stock. Cost: network fees, and the first time for each stock, a deposit of about 0.002 SOL for the partner wallet's account.

Two flags control this. Both are off by default. Leave them off until the code that uses them has merged and been reviewed:

- `STOCK_COLLECTIONS_EXECUTION_ENABLED`: claim each market's stock fees from its pool into the partner wallet's account for
  that stock.
- `STOCK_LAUNCHER_PAYOUTS_ENABLED`: send each launcher their collected 0.30%, in the stock, to the market's launcher wallet.

While they are off, fees build up in the pools. Nothing is lost. The readiness script shows both flags.

## 10. Later: seeding the REPOING/stock pool

On chain: you create a REPOING/stock DAMM v2 pool, add liquidity and lock it forever. Cost: the collected stock and the
REPOING it buys, locked for good; plus SOL for account rent and network fees, which your wallet shows before you sign.

This is your own transaction, from your own wallet. repo.ing never sends it. The accumulator work adds tools that only read
and check:

- **The accumulator view:** for each stock, how much was credited, collected, owed to launchers and spent, and how much is
  available.
- **The pool registration:** records your REPOING/stock pool once its accounts check out on chain.
- **The settlement preview:** how much of the available stock to swap into REPOING and how much to add to the pool, within
  slippage and price-impact limits.
- **The receipt check:** verifies your seed, swap or add-liquidity transaction on chain and records it. Only funds from the
  accumulator count.

Locked liquidity can never be taken out. Read the preview twice before you sign.

## 11. Turning it off again

On chain: nothing. Cost: nothing.

- **To stop new stock launches,** set `STOCK_QUOTES_ENABLED=false` on web, or delete it. Web restarts. The site offers SOL
  pairs only again, and a stock launch already under way is refused at its next step.
- **Existing stock markets keep going.** Their pools live on chain and keep trading. The site still shows and trades them, and
  the worker still records their fees.
- **Leave `STOCK_QUOTE_CONFIGS` as it is.** Existing stock markets need it. Without it the worker reports errors for them.
- **If collections or payouts are on,** set those flags to `false` to stop them.
- The code switch can stay on. To close it as well, revert the switch PR, then deploy web first and the worker after it.
- The configs stay on chain. They cannot be closed.
