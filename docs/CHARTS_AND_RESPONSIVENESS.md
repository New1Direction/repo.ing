# Market charts and responsiveness

## Market charts

The market page uses pinned TradingView Lightweight Charts 5.2.1, loaded separately from the page shell. It supports candles, a closing-price line, SOL volume, crosshair readouts, price/estimated USD market cap, 1H/24H/7D/all history, zoom/reset buttons, dragging, pinch zoom, and keyboard `+` / `-` / `Home`. Both themes and small screens use the existing repo.ing styling. The exact recent-bar table is accessible without using the canvas.

`GET /api/market/:mint/trades?range=all` reads the finalized `trade_events` ledger and, after canonical migration proof, `damm_trade_events` for the same repository’s destination pool. It does not contact Solana RPC or a price provider. The query aggregates all events in the selected window into bounded time buckets; the last-120 list is retained only for recent signatures and indexing feedback. SOL volumes are summed as database numeric integers and returned as lamport strings. Conversion to JavaScript numbers happens only for visualization.

- Candles describe the pool's **post-swap spot prices**, not average execution prices or indicative quotes.
- 1H uses one-minute buckets; 24H uses five-minute buckets; 7D uses hourly buckets. All-history buckets adapt to the actual trading-history span, targeting at most about 500 bars. Inactive days do not coarsen a quiet market's existing history.
- No-trade intervals are whitespace. No flat candles or volume are fabricated.
- Slots and event ordinals order the evidence. If different transactions share a candle's first/last slot, their relative order is not in the current ledger: that candle's prices are withheld and its verified volume retained. A similarly ambiguous latest slot has no claimed latest price. A notice explains this limitation. No signature is treated as a chain-order key.
- A minimum visual price range avoids exaggerating floating-point dust in a flat series.
- USD market cap is estimated from on-chain supply and the current SOL/USD rate. Historical candles are revalued at that rate; they are **not historical USD valuations**.
- After graduation, finalized DAMM post-swap prices continue the chart. Its volume includes both venues. The first DAMM price requires the same immutable repo, curve, mint, destination, slot, and receipt as the durable migration evidence. Before the first DAMM price is indexed, the curve history remains labeled. Missing historical DAMM prices are withheld; their verified volume is retained. The fresh graduation module supplies the trading link.

Supply, holders and SOL/USD load independently through `GET /api/market/:mint/metrics`. Concurrent viewers share in-flight holder/supply and FX requests. Missing metrics remain unavailable rather than becoming zero. Metric display expires; a failed chart refresh retains the last prices with a delayed-update notice and Retry. Polls pause in hidden tabs. A confirmed transaction is not drawn until its swap evidence is indexed.

## Loading and response time

- Home streams its launch/search shell before the market list.
- Explore streams All markets and highlights independently; All markets remains first.
- Analytics streams a range-specific skeleton before its data. Bars expose exact amounts on hover/focus/tap as well as the data table.
- Explore, Find repos, launches and market navigation have shaped skeletons. A shared error boundary offers recovery without suggesting re-submission of a pending transaction.
- The signing/transaction library loads on demand for wallet signing, launch, trade, discovery claim and dormant reinvest UI. Wallet discovery/restoration no longer requires loading it globally.
- Quotes debounce for 250 ms, refresh while visible every 15 seconds, cancel obsolete requests, and reject late responses after an input change. Slow requests time out visibly and can retry. Invalid/excess-balance input cannot submit. Input is locked during submission, duplicate local submits are guarded, and confirmed trades clear old quote amounts.
- Graduation freshness still expires at the evidence deadline; the whole chart/trade subtree no longer re-renders every second just to check that deadline.
- Activity refresh has progress feedback, cancellation and visibility-aware polling.

Transaction signing, settlement, accounting, fee splits, claim authority, and all production spending gates keep their existing server validation. No trading or economic automation is introduced.

## Verification

Local PostgreSQL tests use the explicit dedicated port **55441**, never the production tunnel. Cases cover 130+ trades, canonical pool isolation, OHLC and volume, intra-transaction order, ambiguous same-slot transactions, inactive ranges, sparse series, and missing/invalid evidence. Display, wallet signing/restoration, quote/status, polling and in-flight coalescing regressions are included.

Browser checks cover desktop and 390-pixel mobile layouts, both themes, zoom/reset/keyboard controls, an empty time range, retained prices after a failed refresh, slow independent metrics, and an older quote resolving after the new input's quote. Local visual rows and quote responses were explicitly synthetic fixtures; no mainnet trade, launch or claim was submitted.

The 32 focused checks passed, the production build passed, and the staged patch passed a redacted secret scan. The real PostgreSQL case caught and fixed lexical ordering of a text-cast slot; the final query explicitly sorts the numeric source column.

Before rollout, the production homepage referenced 270,192 gzip-estimated bytes of initial JavaScript. The compiled updated homepage referenced 196,009 bytes: **27.5% less**. The market shell fell from 283,054 to 219,475 bytes (**22.5% less**), before its separate chart-engine download. These are reproducible gzip-size comparisons of script assets referenced by server HTML, not claims about every user's load time. Browser baseline on the live OHIYO page was 255 ms response start and 428 ms first contentful paint in a single warm desktop sample.

Live rollout verification follows below.

## Live release — 2026-09-27 UTC

- Implementation `c77a041`, web deployment `33d9da0c-881f-4fe5-a8d5-f4fc6137d131`: SUCCESS. Worker `6709fac6-36e7-442e-b418-263072ccb6c1` was unchanged; no migrations or economic settings changed.
- Live homepage payload exactly matched the compiled result: 196,009 gzip-estimated bytes, versus 270,192 before (27.5% reduction).
- Home, Explore, Stats and OHIYO returned HTTP 200. Its all-history and 1H chart endpoints returned in 123/122 ms in one HTTP sample; metrics returned in 177 ms. Browser chart requests measured 100 ms while metrics loaded independently in 232 ms.
- The first browser load with fresh release assets painted at 820 ms; a subsequent warm check painted at 376 ms (baseline warm sample: 428 ms). These isolated checks do not establish a population-wide Core Web Vitals result.
- Production desktop and 390-pixel mobile checks found no horizontal page overflow. Wallet restoration remained connected on reload.
- OHIYO has nine indexed trades and four one-minute bars. **One bar is deliberately withheld** because two transactions share a boundary slot and the existing ledger does not store their transaction order. Its volume is included; latest price is verified and displayed. Historical same-slot ordering backfill is a remaining chart-data limitation, not a reason to guess a candle.
- Buybacks, P3 liquidity execution and P4 reinvestment remain false. No financial transaction was submitted by this release.

## Launch polish — 2026-09-27 UTC

This follow-up addresses sparse-market rendering and interaction stability:

- Quiet histories (fewer than 12 verified price bars on the first response) start in line view. Dense histories start with candles. A user's explicit Line/Candles choice is remembered locally. Line view connects bucket closes; it does not smooth, interpolate extra trades, or replace OHLC evidence.
- Sparse candle views reserve at least 40 logical time slots and cap candle spacing. Blank viewport space does not add price/volume observations. Zoom buttons keep the newest visible edge anchored; resize and unchanged polls preserve the view.
- Unchanged series produce no data writes. Last-bar updates and appends use the chart engine's incremental update path. Historical corrections, rolling windows, changed denominations and withdrawn evidence replace the affected series without resetting the viewport.
- The canvas remains mounted during period changes and empty periods. A pending/failed request names both the requested and still-displayed period. No old period is silently relabeled.
- Crosshair readouts update at most once per animation frame and only when the time bucket changes. Fixed readout rows prevent hover-related layout changes. Mobile controls, both themes, and reduced-motion behavior retain the existing GitHub-style design.
- The footer distinguishes fresh indexed data from the age of the latest trade. USD metric failure does not silently change the selected chart to SOL. An unavailable USD estimate is covered and labeled, with a direct action to show SOL prices.
- Trade estimates remain visible during a same-input background refresh, with a refresh indicator. Changing inputs, quote failure, or a 30-second display deadline clears the estimate. Preparing a trade still obtains the server's fresh quote before wallet confirmation.
- Market-keyed chart and trade components prevent input/view state from carrying into another token.

Local verification: 34 focused tests passed; the existing PostgreSQL aggregation test was skipped because this follow-up changes no server aggregation or database code. Browser rehearsal used public OHIYO history and explicitly synthetic local metrics/quotes. It verified canvas identity across pending/empty periods, byte-identical chart pixels after an unchanged zoomed refresh, missing-USD recovery, both themes, 390-pixel layout with no horizontal overflow, and same-input quote retention versus changed-input invalidation. No local fixture route is included in the release. Same-slot ordering without durable transaction ordering evidence remains withheld as documented above.

Release confirmation: implementation `c396c35`, Railway web deployment `b1f5fe42-0b84-45c8-8346-d9c7e860b3fd` succeeded. Live browser checks confirmed the quiet-market Line default, last-trade age, canvas retention through All → empty 1H → All, wallet restoration, and no page overflow on desktop or 390-pixel mobile. The separate local quote-expiry rehearsal confirmed the estimate and fee details clear after 30 seconds without refresh and expose Retry. The production build and staged secret scan passed. Worker deployment was unchanged; buyback, P3 and P4 execution gates were read back as false. No financial transaction was submitted.

## Graduation continuity and launch invitation — September 27 follow-up

The DAMM indexer now persists `swapResult.nextSqrtPrice` from the installed SDK’s decoded `evtSwap2`. The event must be a successful canonical swap CPI, with the correct token/SOL orientation and fee collection mode. Both RPCs already agree on finalized transactions before indexing. `0020_damm_chart_prices` adds a nullable evidence column; it never invents prices for older rows. There were zero production DAMM trades at the pre-deployment check.

Chart aggregation joins only the pool bound by hashed durable graduation evidence. Cross-repository, wrong-pool, and pre-migration rows are excluded. Finalized block ordering verification now covers DAMM and DBC. The same Q64 price convention and token/SOL decimals apply to both. Migration receipts are linked. Expired migration progress never reopens the curve trade form after the UI has observed that curve trading ended.

Launch is a green navigation action, URL resolution has a labeled Review repo button, and Home/Launch explain the three steps and existing discovery reward limits. Find repos keeps its separate tab and approved candidates have a primary Review & launch action. No launcher, fee split, trading execution, or spending gate changes.

### September 27 — launch visibility and graduation continuity checks

- Launch navigation and repository review use the primary green action style in dark and light modes. Home and Launch explain discovery, wallet approval, and reward limits in three steps.
- Native chart history combines finalized DBC swaps with only the immutable migration's same-repository DAMM destination. DAMM event prices come from the installed SDK's `evtSwap2.swapResult.nextSqrtPrice`. Exact SOL volume remains independent of price availability.
- The old curve trade form stays closed after a migration is observed, including during a subsequent progress-read failure. Chart and trade panel keys are distinct to avoid React reconciliation collisions.
- Local PostgreSQL rehearsals cover destination/repository/migration binding, pre-migration and foreign-pool exclusion, same-slot ordering, and missing-price handling. The SDK event fixture checks both trade directions, Q64 price conversion, zero prices, and unsupported fee assets.
- Browser checks cover desktop and 390px mobile layouts, light/dark launch styles, and a clearly labeled local synthetic DAMM fixture. The fixture was removed before the production build. No test market or volume was introduced on mainnet.
- No market had graduated at the pre-release production check. Post-graduation chart continuity is locally verified, awaiting its first real production graduation. The financial execution gates remain disabled.
