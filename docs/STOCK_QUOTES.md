# Stock-paired markets

Status: built dark through quote-aware market creation (P6a). The registry, the market columns, the quote-options API, the
"Choose pair" control and stock-pair creation exist. Nothing can be launched against a stock yet: the code's own gate
(`STOCK_PAIR_LAUNCHES_READY` in `src/quote-assets.mjs`) stays closed until trading, indexing, payouts and reconciliation are
quote-aware too, and `STOCK_QUOTES_ENABLED` is off. Every surface offers SOL only.

A launcher can pair a repository's market with SOL (the default, and the quote of every market launched so far) or, when
the repository belongs to a GitHub organization mapped to a listed company, with that company's tokenized stock:

```text
facebook/docusaurus  → DOCUSAURUS / METAx      microsoft/vscode → VSCODE / MSFTx
```

A repository still has exactly one market and that market one quote asset, chosen at launch, stamped on the market and
never resolved again.

## Registry (`src/quote-assets.mjs`)

Explicit and versioned (`QUOTE_REGISTRY_VERSION`); nothing is inferred at runtime.

```text
GitHub owner (numeric id, verified organization) → company → tokenized stock → pinned Solana mint
```

| GitHub organization | Owner id | Company | Asset id | Symbol | Mint |
| --- | --- | --- | --- | --- | --- |
| facebook | 69631 | Meta Platforms | `meta-xstock` | METAx | `Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu` |
| microsoft | 6154722 | Microsoft | `msft-xstock` | MSFTx | `XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX` |
| nvidia | 1728152 | NVIDIA | `nvda-xstock` | NVDAx | `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` |

- Owners match by numeric id, never by login: a login can be renamed and later registered by someone else. Only
  organizations count; a user account never maps to a company.
- Mints come from Backed's Assets API (`https://api.xstocks.fi/api/v2/public/assets/<symbol>`, network "Solana") and were
  read on mainnet on 2026-10-03: Token-2022, 8 decimals. They are the same mints as the tip allowlist
  (`src/tip-tokens.mjs`); `tests/quote-assets.test.mjs` keeps the two in agreement.
- Changes are append-only. An asset id's mint never changes, because historical markets resolve through their stamp; a
  provider migration is a new asset id. `enabled: false` stops new launches only. Bump the version with every change.
- A client sends only `quoteAssetId`. Tickers, mints and company names are never accepted, and the server re-derives
  eligibility from the owner GitHub reports at that moment.

## API

`GET /api/repos/<repoId>/quote-options`

```json
{ "repoId": "94911145", "registryVersion": 1, "options": [
  { "type": "SOL", "assetId": "sol", "symbol": "SOL", "eligible": true },
  { "type": "TOKENIZED_EQUITY", "assetId": "meta-xstock", "symbol": "METAx", "ticker": "META", "company": "Meta Platforms",
    "githubOrg": "facebook", "provider": "backed-xstocks", "eligible": true } ] }
```

- SOL only, without reading GitHub, while the switch is off and for Hugging Face models.
- Otherwise the owner comes from a live GitHub read. If GitHub cannot confirm the owner id (the stored row is all that is
  left), only SOL is offered.
- Answers are kept for 60 s per repository and process (public, `s-maxage=60`).
- A mapped company whose asset is disabled is listed with `eligible: false` and its code.

Refusals carry a stable `code`: `COMPANY_MAPPING_NOT_FOUND`, `STOCK_ASSET_NOT_FOUND`, `STOCK_ASSET_DISABLED`,
`QUOTE_ASSET_INVALID`, `QUOTE_ASSET_MISMATCH`, `UNSUPPORTED_QUOTE_ASSET`. Nothing ever falls back from a stock to SOL.

For the trade panel (P6b):

- `GET /api/quote-assets/<assetId>` (`src/quote-asset-info.mjs`) returns a registry stock's display facts:

  ```json
  { "assetId": "meta-xstock", "symbol": "METAx", "decimals": 8, "uiMultiplier": "1.0028515433272898", "usdPrice": 712.5 }
  ```

  - `uiMultiplier` is the mint's ScaledUiAmount multiplier in force now, read from chain and kept a minute.
  - `usdPrice` is Jupiter's price per whole raw token, read as tips read it, or `null`.
  - SOL and unknown ids are 404; a failed mint read is 503.
- `GET /api/wallet/balance?wallet=<address>&asset=<assetId>` returns `{ assetId, decimals, balanceBaseUnits }`: the raw
  balance of the wallet's associated Token-2022 account for that stock, which is the account stock trades spend from. No
  account is `"0"`; a failed read is 503, never zero. Without `asset`, the route answers the SOL balance as before.

## Data (migration 0053)

`markets.quote_asset_id`, `quote_mint` and `quote_registry_version`:

- All three are null for SOL, so existing rows and SOL code paths are unchanged.
- A stock stamp is all three or none, never an explicit SOL, and GitHub markets only (`markets_quote_asset_check`).
- `protect_market_quote` refuses any change once the launch transaction was sent or the market is indexed. A reservation
  that never sent one may be replaced with another pair.

## Launching a stock pair (P6a)

- **One DBC config per stock**, created by the owner with `scripts/create-stock-quote-config.mjs --asset meta-xstock
  --graduation <whole units>` (dry run by default; it sends only with the reviewed address, instruction hash and debit approved
  in the environment). The config carries the live SOL launch-fee config's terms field by field (`STOCK_CONFIG_MUST_MATCH` in
  `src/stock-quote-config.mjs`): the review refuses anything else before a key is loaded. Only the quote mint (through
  Token-2022, with Meteora's badge) and the graduation threshold differ. Then set `STOCK_QUOTE_CONFIGS` on web and worker.
- **At prepare and again after the wallet signs** (`app/lib/stock-launch.mjs`), a stock pair needs: stock launches ready, a
  GitHub repository launched from its launch page (no trend or agent-draft shortcut), the stock of the company that owns the
  repository on GitHub right now (a live read by numeric owner id), that stock's registered config, and the mint usable now
  (not paused, no active transfer hook or fee, accounts not frozen by default).
- **The launcher** checks every field of the config as for SOL, plus the stock's mint and the Token-2022 flag, and passes
  Meteora's badge. A stock-paired launch has no initial buy yet; the form says so and the trade panel can buy right after.
- **The reservation** stamps the pair and carries none of the SOL-denominated rewards (discovery, verification bonus,
  builder allocation).
- **Launch evidence and the indexer** resolve the pool through the quote-aware resolver. Every other path still uses the SOL
  resolver, which refuses a stock-paired market loudly, so nothing can misread one until it is made quote-aware.

## Trading a stock pair (P6b, curve)

The site's curve trade path (`src/canonical-trade.mjs`: quote, prepare, submit, verify) handles a stock-paired market by its
stamp:

- **Routing:** the trade router (`src/canonical-damm-trade.mjs`) reads a stock-paired curve through its quote-aware config,
  so the curve trader handles it. The graduated (DAMM v2) trader is still SOL-only, so a graduated stock-paired market is
  refused until that path is quote-aware.
- **The swap** is the one DBC swap with the stock as its quote (`assertPreparedStockDbcSwap`). Its config, pool, both mints,
  the wallet, its input and output accounts (the stock's through Token-2022) and both token programs are pinned. Nothing is
  wrapped or closed, and there is no referral, because referrals pay through wrapped SOL. Besides the compute budget, the
  only other instructions allowed create the wallet's own account for the market token or the stock, idempotently, under
  that mint's token program.
- **Settlement** is checked in raw units of each token (`assertStockDbcSettlement`):
  - a buy spends exactly the input of the stock and receives at least the minimum;
  - a sell gives exactly the input and receives at least the minimum of the stock;
  - the pool's stock vault moves the other way.

  Raw units are unaffected by the scaled-UI multiplier.
- **Costs** (`src/trade-costs.mjs`): SOL pays only the network fee and account rent. The stock account's rent is for the size
  Token-2022 creates it at (`associatedAccountLength`: 179 bytes for METAx); a stock mint with an extension the estimate does
  not know fails the estimate. The stock is checked separately (`quoteBalance`, `quoteShortfall`), and a buy larger than the
  wallet holds is refused before signing ("You need approximately … more METAx", rounded up). A failed balance read fails
  the estimate; it is never taken as zero.
- **Records and results:** the trade record carries `quoteMint`. Results add `quoteDelta` and `quoteMint`; SOL trades return
  exactly what they did before.
- **Blinks** (`app/lib/solana-actions.mjs`) are worded and sized in SOL, so a stock-paired market is never offered through
  them: the action routes answer 404 with "Blink trades are available for SOL markets only", and the action trade builder
  refuses a stock-paired trade as a backstop.

### The trade panel

The token page passes the market's pair (`marketQuoteView`) to the trade panel. A SOL market is exactly as before. For a
stock pair, the panel buys with the stock and sells for it:

- **Units as wallets show them.** xStocks are Token-2022 ScaledUiAmount mints: wallets show raw × multiplier (about 1.0029
  for METAx), while trades, fees and settlement stay in raw units.
  - The panel shows every stock amount that way: balance, receive, minimum received, trading fee, shortfall, result.
    It converts with BigInt arithmetic and truncates, as Token-2022 does (`app/lib/trade-units.mjs`).
  - A typed or preset amount converts back to raw units rounded down, so it never spends more than it says. A dust
    balance that would convert back to nothing gets no preset.
  - Until the stock's units load, the panel takes no amount.
- **Balances and presets.** A buy shows the wallet's stock balance and offers 25%, 50% and MAX of it. SOL still pays the
  network fee and any account deposit, shown as "SOL costs".
- **Shortfalls.** A buy beyond the stock balance reads "Not enough METAx", and a missing amount of the stock is shown rounded
  up. A SOL shortfall for costs still reads "Not enough SOL".
- **USD estimate** at the stock's own price.
- **Not offered for stock pairs:** the SOL trade size guide. A graduated stock-paired market shows trading as not open yet,
  because the graduated trader is SOL-only. A market whose stamp no longer matches the registry shows trading as paused.

A launch draft also keeps its chosen pair. On restore, the pair is used only while the repository is still offered it;
otherwise the form switches to SOL and says so.

Fee accrual and the worker's indexing of stock-paired trades come next. Until then, a confirmed stock trade stays confirmed
and its fee recording raises the usual operator alert.

`tests/stock-pair-chain.test.mjs` proves this on the programs mainnet runs (`scripts/ci/start-stock-validator.sh` loads the DBC,
DAMM v2, Token-2022 and Metaplex programs as deployed, Meteora's badges for METAx, and the METAx mint with only its mint
authority replaced):

- a METAx config is reviewed and created;
- DOCUSAURUS / METAx is prepared on one replica and submitted from another;
- its evidence and indexing match;
- a trader buys with exactly 1 METAx and the creator and partner fees accrue in METAx;
- the site's trade path, routed as `/api/trade` routes it, quotes, prices, prepares, submits and verifies a 0.5 METAx buy
  and a full sell-back to the raw unit, and refuses a buy larger than the wallet's METAx before signing;
- a wallet with no METAx account sells: the estimated deposit is exactly the rent of the 179-byte account Token-2022
  creates;
- a SOL launch on the same programs is unchanged.

To run it locally:

```bash
scripts/ci/start-stock-validator.sh <work-dir>
STOCK_CHAIN_WORK_DIR=<work-dir> node --test tests/stock-pair-chain.test.mjs
```

The test needs PostgreSQL on 127.0.0.1:55432. Stop the validator afterwards and delete `<work-dir>/ledger`.

## Fee policy (decided 2026-10-03)

| | Curve fee |
| --- | --- |
| Total | 1.75%, unchanged |
| Meteora | 0.35% |
| Launcher, while the repository is unclaimed | 0.30%, carved from the builder share |
| Builder escrow for the owner, while unclaimed | 0.694% |
| Verified owner, after the claim | the full 0.994% |
| repo.ing | 0.406%, into that stock's protocol accumulator |

- At the first admin verification the launcher-side 0.30% switches to the verified owner from then on. The switch slot,
  time and verification are recorded, and the launcher keeps everything earned before it.
- Discoverer rewards are off for stock markets: the launcher's 0.30% replaces them.
- All of these fees are paid in the stock token, because the curve collects fees in its quote.
- repo.ing's 0.406% accumulates per stock asset. A bounded, operator-run settlement later swaps about half into REPOING
  and adds both sides as permanently locked liquidity to one canonical REPOING/stock pool per stock. Every repository
  paired with the same stock feeds the same pool.

## Issuer powers

Read on mainnet on 2026-10-03, for METAx (MSFTx and NVDAx are the same). Meteora approved these three mints for DBC and
DAMM v2 on 2026-09-09.

- **Pause:** the issuer can stop every transfer. Swaps, claims, migration and the locked REPOING/stock pool halt while
  paused.
- **Freeze:** the issuer can freeze accounts, including pool vaults.
- **Permanent delegate:** can move or burn any balance, pool vaults included.
- **Transfer hook:** dormant today. If the issuer sets one, xStock pools stop.
- **Scaled UI amount:** a multiplier for splits and dividends. Curve math uses raw units; displays must apply the
  multiplier.
- **Holder restrictions:** Backed's terms exclude U.S. persons, UK retail clients and sanctioned jurisdictions. The issuer
  can end a product on 30 business days' notice, so permanently locked stock may never be redeemable.
- **Owner action:** have this reviewed legally before the switch goes on.

## Roadmap

Each phase ships dark behind `STOCK_QUOTES_ENABLED`:

1. **P5 (done):** the "Choose pair" control on the launch form. The launch API refuses any pair it cannot launch.
2. **P6a (done):** quote-aware creation: config per stock, pool derivation, launch checks, evidence and indexing.
   **P6b (done):** the curve trade path, and the trade panel in the stock's units.
3. **P6, the rest:** quote-aware trading and indexing. Every remaining place that assumes SOL takes the market's quote:
   - the worker's approved configs;
   - trade preparation and verification (no wrapped SOL; Token-2022 quote accounts; decimals from the asset);
   - DBC and DAMM event parsing and fee accrual;
   - graduation;
   - charts, market cap and USD prices, with stock amounts shown as wallets show them (the trade panel already does);
   - platform totals, split by asset.

   Fix every part together: a partial fix would make the worker skip stock fees silently.
4. **P7:** launcher fee routing and the recorded switch, quote-aware claims and reconciliation.
5. **P8–P10:** the per-stock accumulator, the canonical pool registry and settlement previews with receipts, with
   spending off.
6. **P11:** settlement execution behind an operator flag.
7. **P12:** adversarial tests.

Owner actions before launch:

- **One DBC config per stock.** The graduation threshold is denominated in that stock, and the launch-fee decay matches
  today's.
- **One canonical REPOING/stock DAMM v2 pool,** seeded from the treasury.

Both are on-chain steps: scripts will print a dry run and a plain description first, and nothing is sent without the
owner's approval.
