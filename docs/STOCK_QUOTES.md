# Stock-paired markets

Status: groundwork only. The registry, the market columns and the quote-options API exist. `STOCK_QUOTES_ENABLED` is off,
so nothing can be launched against a stock and every surface offers SOL only.

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

## Data (migration 0053)

`markets.quote_asset_id`, `quote_mint` and `quote_registry_version`:

- All three are null for SOL, so existing rows and SOL code paths are unchanged.
- A stock stamp is all three or none, never an explicit SOL, and GitHub markets only (`markets_quote_asset_check`).
- `protect_market_quote` refuses any change once the launch transaction was sent or the market is indexed. A reservation
  that never sent one may be replaced with another pair.

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

1. **P5:** the "Choose pair" control on the launch form. The launch API refuses any pair it cannot launch.
2. **P6:** quote-aware creation, trading and indexing. Every place that assumes SOL takes the market's quote:
   - config and pool derivation;
   - launch evidence and the worker's approved configs;
   - trade preparation and verification (no wrapped SOL; Token-2022 quote accounts; decimals from the asset);
   - DBC and DAMM event parsing and fee accrual;
   - graduation;
   - charts, market cap and USD prices (Jupiter by mint, as tips use);
   - platform totals, split by asset.

   Fix every part together: a partial fix would make the worker skip stock fees silently.
3. **P7:** launcher fee routing and the recorded switch, quote-aware claims and reconciliation.
4. **P8–P10:** the per-stock accumulator, the canonical pool registry and settlement previews with receipts, with
   spending off.
5. **P11:** settlement execution behind an operator flag.
6. **P12:** adversarial tests.

Owner actions before launch:

- **One DBC config per stock.** The graduation threshold is denominated in that stock, and the launch-fee decay matches
  today's.
- **One canonical REPOING/stock DAMM v2 pool,** seeded from the treasury.

Both are on-chain steps: scripts will print a dry run and a plain description first, and nothing is sent without the
owner's approval.
