# Stock-paired markets

Status: built dark through quote-aware creation (P6a) and the curve trade path with its trade panel (P6b). The registry, the
market columns, the quote-options API, the "Choose pair" control, stock-pair creation and curve trading exist. Fee accrual,
graduation and payouts are being built, on separate stock ledgers (migration 0054) under the decided fee policy. Nothing can be
launched against a stock yet: the code's own gate (`STOCK_PAIR_LAUNCHES_READY` in `src/quote-assets.mjs`) stays closed until
trading, indexing, payouts and reconciliation are quote-aware too, and `STOCK_QUOTES_ENABLED` is off. Every surface offers SOL
only.

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
  { "assetId": "meta-xstock", "symbol": "METAx", "decimals": 8, "uiMultiplier": "1.0028515433272898", "validForSeconds": 120,
    "usdPrice": 712.5 }
  ```

  - `uiMultiplier` is the mint's ScaledUiAmount multiplier in force now (`src/scaled-ui-amount.mjs`). The mint's extension
    is read at most every 30 s; the multiplier in force is worked out on every request, so an issuer's scheduled change
    applies on the second it takes effect.
  - `validForSeconds` is how long the panel may use these units: until a change the issuer has scheduled, and at most 120 s.
  - `usdPrice` is Jupiter's price per whole raw token, read as tips read it. It is `null` when there is no price, or when
    none arrives within 0.8 s, so a slow price never holds up the units.
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
  wallet holds is refused before signing ("You need approximately … more METAx", in the units wallets show, rounded up).
  A failed balance read fails the estimate; it is never taken as zero.
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
  - Until the stock's units load, the panel takes no amount. Units lapse after `validForSeconds` unless a refresh renews
    them, and are then read again at once. A scheduled multiplier change is applied on time, and units that cannot be
    refreshed stop the panel rather than convert with a stale multiplier.
- **Balances and presets.** A buy shows the wallet's stock balance and offers 25%, 50% and MAX of it. SOL still pays the
  network fee and any account deposit, shown as "SOL costs".
- **Shortfalls.** A buy beyond the stock balance reads "Not enough METAx", and a missing amount of the stock is shown rounded
  up. A SOL shortfall for costs still reads "Not enough SOL".
- **USD estimate** at the stock's own price.
- **Not offered for stock pairs:** the SOL trade size guide. A graduated stock-paired market shows trading as not open yet,
  because the graduated trader is SOL-only. A market whose stamp no longer matches the registry shows trading as paused.

A launch draft also keeps its chosen pair. On restore, the pair is used only while the repository is still offered it;
otherwise the form switches to SOL and says so.

### Indexing a stock pair's curve (dark)

A stock-paired market's curve trades and fees are recorded only in the stock ledgers (migration 0054); every SOL table and SOL
query is unchanged.

- **Evidence** (`src/stock-trade-evidence.mjs`) takes the market's stock mint and config as required arguments and is strict.
  The SOL parser reads anything it does not recognise as "not a swap", which for a stock pair would credit a missed swap
  nothing and move the cursor past it for good. Here every DBC instruction that names the canonical pool must be fully
  matched: a canonical swap with exactly one swap event (evtSwap and evtSwap2 must agree when both appear), or a known
  non-swap (the launch, fee claims, metadata, a creator transfer) with the pool, config and mints in their places. Every swap
  event naming the pool must come from a canonical swap. Anything else is quarantined (`STOCK_FEE_EVIDENCE_QUARANTINED` on the
  operator alert feed), retried every run and credited once it can be matched. A migration instruction is an ERROR: graduation
  is indexed separately. Event ordinals are the SOL parser's, so (signature, event_index) means the same in both ledgers.
- **Accrual** (`src/stock-fee-accrual.mjs`) checks the market's stamp against the registry, its registered stock config, the
  live curve (pool, creator, not migrated) and the config (the stock as quote through Token-2022, fees collected in the stock,
  creator share 71%). Each swap becomes one `stock_fee_events` row (the creator's 71% of the trading fee rounded down, the
  partner the rest, split by `splitCurveFee` with its `policy_version`) and one `stock_trade_events` row (venue `dbc`: a buy's
  fee-excluded stock input and the tokens out, a sell's tokens in and stock out, all raw), written in one transaction and
  idempotent on (signature, event_index).
- **Worker** (`src/stock-fee-indexer.mjs`): exactly the markets the SOL indexer leaves out (`quote_asset_id is not null`), with
  cursors in `stock_pool_cursors`, its own schedule and an activity feed over the configs in `STOCK_QUOTE_CONFIGS`. A missing
  config, a changed or migrated curve, an RPC failure or a cursor missing from history is an ERROR, and the worker exits
  non-zero. A malformed `STOCK_QUOTE_CONFIGS` fails stock markets only.
- **Trade route:** a confirmed stock trade's fees are recorded through the stock accrual (by its prepared quote mint); a SOL
  trade's exactly as before.
- **Charts:** chart ordering also places stock trades' transactions in their finalized blocks.

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
- every METAx trade reaches the stock ledgers through the trade route's settlement and the worker's stock job: the summed
  creator and partner fees equal the pool's own creator and partner fee counters to the raw unit, a replay credits nothing
  twice, and the SOL indexer leaves the market out with every SOL ledger empty;
- a SOL launch on the same programs is unchanged.

To run it locally:

```bash
scripts/ci/start-stock-validator.sh <work-dir>
STOCK_CHAIN_WORK_DIR=<work-dir> node --test tests/stock-pair-chain.test.mjs
```

The test needs PostgreSQL on 127.0.0.1:55432. It reads the validator's RPC port from `STOCK_VALIDATOR_RPC_PORT` (default 8919),
as the script does. Stop the validator afterwards and delete `<work-dir>/ledger`.

## Fee policy (policy 1)

| | Curve fee |
| --- | --- |
| Total | 1.75%, unchanged |
| Meteora | 0.35% |
| Launcher | 0.30%, carved from the 0.994% builder share, forever |
| The stock's accumulator | 1.10%: the rest of the builder share (0.694%) and repo.ing's 0.406% |

- **The launcher** gets 0.30% of every trade, paid in the stock, for as long as the market trades. There is no end date and
  no switch.
- **A company admin who verifies the repository changes nothing.** There is no owner claim of builder fees on a stock pair;
  one is refused with `STOCK_PAIR_NO_OWNER_CLAIM`.
- **Everything else**, the rest of the builder share and repo.ing's whole 0.406%, goes to that stock's accumulator. It is
  destined to become permanent REPOING/stock liquidity.
- **The accumulator is per stock:** every repository paired with the same stock feeds it. The owner seeds one canonical
  REPOING/stock pool per stock later, from the accumulated fees. repo.ing builds only the accounting, previews, dry-run tools
  and receipt verification for this. Nothing creates pools or configs, or sends transactions, on mainnet.
- **No other rewards:** stock markets carry no discovery reward, verification bonus or builder allocation.
- **Units:** all of these fees are paid in the stock, because the curve collects fees in its quote. Ledgers keep raw units;
  the ScaledUiAmount multiplier is for display only.

The arithmetic is `src/stock-fee-policy.mjs` (`POLICY_VERSION` 1, BigInt, every share rounded down):

- **The config:** the stock's DBC config gives the creator 71% of the fee after Meteora's (0.994% of volume).
  `assertStockPolicyConfig` refuses any other share.
- **Each curve swap** (`splitCurveFee`): the launcher gets `floor(creator fee × 150 / 497)`, which is 0.30 / 0.994 of it.
  The rest of the creator fee and the whole partner fee go to the accumulator.
- **After graduation** (`dammCheckpoint`): fees are read as cumulative checkpoints of the DAMM v2 creator and partner
  positions, and each checkpoint credits the growth since the last.
  - The launcher's running total is `floor(creator position's earned fees × 150 / 497)`.
  - The partner position's fees all go to the accumulator.
  - A cumulative that goes backwards is refused for review, never credited negative.

## Stock ledgers (migration 0054)

Stock-pair accounting lives only in its own `stock_*` tables. No SOL table, query or row changes, and SOL-only code keeps
refusing stock markets. Amounts are raw units of each token.

- `stock_trade_events` and `stock_pool_cursors`: every swap on a stock-paired curve or graduated pool, and the worker's
  position in each pool's history.
- `stock_fee_events`: each curve swap's creator and partner fee and its split, with the `policy_version`. The database checks
  `creator + partner = launcher + accumulator` and `launcher <= creator`.
- `stock_graduation_observations` and `stock_graduation_events`: curve progress, and the migration to DAMM v2 with its two
  positions.
- `stock_damm_fee_checkpoints`: cumulative checkpoints of those positions. The database checks
  `credit = launcher_credit + accumulator_credit`, and the partner side never pays the launcher.
- `stock_fee_collections` and `stock_launcher_payouts`: fee claims and launcher payouts.
  - At most one is pending per market and source (collections) or per market (payouts).
  - A settled one carries its signature, settlement time and receipt (a collection also the amount received). A pending one
    has no settlement time.
  - A payout goes only to the market's `launcher_wallet`.
- `stock_canonical_pools` and `stock_settlement_receipts`: at most one active REPOING/stock pool per stock, and verified
  settlement receipts.
- **The market check:** a trigger refuses any row whose market, `asset_id` and `quote_mint` do not match the market's stamp,
  so a SOL market or another stock can never enter these ledgers. Once stored, a row can never move to another market or
  stock.
- **Live updates:** new stock trade and fee rows of a live market send hints on `repoing_stock_market_updates`
  (`{ "mint", "kind": "trade" | "fee" }`). The SOL channel is unchanged.

`tests/stock-ledgers-db.test.mjs` proves this on PostgreSQL, including that every existing row and definition is unchanged.

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
4. **P7:** launcher fee routing (policy 1, above), quote-aware claims and reconciliation.
5. **P8–P10:** the per-stock accumulator, the canonical pool registry and settlement previews with receipts, with
   spending off.
6. **P11:** settlement execution behind an operator flag.
7. **P12:** adversarial tests.

Owner actions:

- **Before launch, one DBC config per stock.** The graduation threshold is denominated in that stock, and the launch-fee decay matches
  today's.
- **Later, one canonical REPOING/stock DAMM v2 pool per stock,** seeded by the owner from that stock's accumulated fees.

Both are on-chain steps: scripts will print a dry run and a plain description first, and nothing is sent without the
owner's approval.
