# Public API audit — 2026-10-14

Audited against the repository implementation and read-only HTTPS requests to
`https://repo.ing`. All five SDK endpoints returned HTTP 200 and passed their runtime
schemas during the audit. Deployed `X-Repoing-Api-Version`: **2026-10-13**.
This is a compatibility observation, not an availability or execution guarantee.

## What actually exists

| API | Actual contract and limitations |
| --- | --- |
| `GET /api/v1/launches` | `{generatedAt, scheduled, groupLaunches, recentLaunches}`. Recent means seven days, at most 100; group raises at most 100. Not a complete market registry. |
| `GET /api/v1/launches/events` | `{events, kinds, next}`. IDs are decimal strings. `limit=1..200`; `kind` is comma-separated; `repo` accepts up to 50 IDs. No `after` means newest-first; `after=<id>` means ascending, exclusive. Only forward pagination exists. Empty page ends a drain, not the feed. |
| `GET /api/v1/liquidity` | `{generatedAt, markets, impactPercent:2, spreadSizeLamports:"100000000", incentives}`. Up to **500** confirmed/finalized SOL markets with stored samples, sorted by depth. No cursor. Samples are hourly, not executable quotes. Incentives are previews and pay nothing. |
| `GET /api/v1/markets/<mint>/liquidity` | **Envelope** `{market, liquidity, note}`, not a bare profile. `liquidity.version=1`, `venue=curve|damm`, `pool`, `checkedAt`, Q64 `sqrtPrice`, decimal `lamportsPerToken`, nullable `feeBps`, `depth[]`, `spreads[]`, nullable reserves/threshold, summary. SOL markets only. |
| `GET /api/v1/markets/<mint>/transparency` | `{market, generatedAt, report, liquidity, seeded, mechanism, schedule, disclosures}`. Stored reports and samples can be null. Nested evolving report facts stay `unknown`; the SDK does not infer trading permissions or execution quality from scores. |

**Amounts:** SOL lamports (10⁹/SOL), token base units (10⁶/token), serialized as
decimal strings. Spot in lamports per token base unit is `sqrtPrice² / 2¹²⁸`.
The human-readable `lamportsPerToken` is per **whole** token; treating it as per
base unit is a million-fold sizing error. The paper engine uses only integer Q64
arithmetic, never the rounded display price.

**Depth:** 1/2/5% average price impact excluding fees, computed from exact Meteora
quotes on one snapshot. Spreads at 0.1/1 SOL include fees; null means unavailable,
not zero. The SDK must not extrapolate these bands into execution guarantees.

**Transport:** public, cookie-free GET; no API key. JSON errors are usually
`{error}`. The liquidity limiter returns `429`, `Retry-After` seconds and
`{error, code:"RATE_LIMITED"}`; unlike successful responses it does not currently
include API-version/CORS headers. Therefore the SDK checks HTTP errors before
checking the version header. Live liquidity allows 30 burst / 30 per minute per
address per web process; this is not a global SLA. Default SDK pacing is one
request per 2.1 seconds across a shared client, including retries. Clients across
processes must coordinate their own shared address budget; never rotate addresses
to bypass a limit.

**Caching/freshness:** live liquidity has a 10-second process cache and edge TTL
10 seconds with 20 seconds stale-while-revalidate. Calendar 30/60 seconds, events
15/30, board 60/120, transparency 60/120. Board `generatedAt` is not `sampledAt`.
`checkedAt` is a server timestamp, not a slot or block-finality guarantee. Keep a
synchronized system clock and reject stale data. There is no atomic multi-market
snapshot and no guaranteed event delivery latency. Feed creation initially looks
back 14 days; the feed is not an archival history API.

## What this SDK deliberately cannot claim

- No public limit-order submission/cancellation, order book, queue priority,
  maker-fill stream, or maker-specific liquidity deposit API exists in `/api/v1`.
- `/api/market/<mint>/events` is a web SSE **invalidation** channel. It emits
  `{mint,kind}`, not price/depth/fills, has no durable cursor, and expires after
  about 55 seconds. The SDK uses explicit, backpressure-aware polling instead.
- `/api/trade` is an unversioned web AMM swap API: quote/costs/depth, prepare,
  wallet-signed submit, status. A prepare simulation is not a paper fill. These
  actions are not wrapped by this SDK. Repeated opposing AMM swaps would consume
  liquidity and could manufacture volume; they are not resting maker quotes.
- Nobody adds liquidity to the pre-graduation curve. Post-graduation DAMM LP
  positions are a separate on-chain integration requiring independent review;
  this SDK neither manages LPs nor promises rewards.
- There is no preferential access. Published launch restrictions, blocked-wallet
  rules and any contributor access rules remain in force. This SDK grants no
  exemptions and has no hidden keys or privileged endpoints.

## Source of truth and repeatable conformance checks

Repository paths (relative to the repository root):

- `docs/MARKET_DATA_API.md` — public reference.
- `app/api/v1/{launches,launches/events,liquidity}/route.js` — response envelopes.
- `app/api/v1/markets/[mint]/{liquidity,transparency}/route.js` — per-market routes.
- `app/lib/{public-api,request-limits,launch-calendar,market-transparency}.mjs` — headers, limits, SQL caps, report JSON.
- `src/{launch-feed,launch-schedules,market-liquidity}.mjs` — cursors, public schedules, snapshot math.
- `app/api/market/[mint]/events/route.js`, `app/api/trade/route.js` — excluded web interfaces.

`conformance/routes.test.mjs` executes real GET handlers, real serializers, feed
query parsing and profile math with disposable storage/chain adapters. This tests
wire compatibility without keys, migrations, production writes or a validator.
It does not prove on-chain execution. The public live audit covered board,
calendar, events, transparency and a graduated SOL liquidity snapshot; offline
conformance additionally covers curve data and null/failed quotes.
