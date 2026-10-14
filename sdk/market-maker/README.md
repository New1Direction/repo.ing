# @repoing/market-maker

Typed public market data and deterministic paper market making for Node.js 22+,
ES modules, AGPL-3.0-only. **No live execution, key custody, signing, or wallet
loading.** This is a market-data/research SDK, not a live order venue or investment
advice. Read [the API audit](API_AUDIT.md) before integrating: repo.ing currently
exposes AMM snapshots, not resting limit orders.

## Run locally — simulation is the default

From the repository root:

```sh
npm --prefix sdk/market-maker ci --ignore-scripts
npm --prefix sdk/market-maker test
npm --prefix sdk/market-maker run example
```

The example uses a fixed synthetic tape, a fixed clock, fictional external
customers and integer accounting. Repeated runs are byte-for-byte identical. It
does not access the network or read environment variables/secrets. JSON output
labels the mode, quotes, fees, inventory, turnover, mark-to-market P&L and stops.
Bid and ask quotes are both shown; fictional customers buy the paper ask. There
is no automatic opposing-swap loop.

To read public live data, **explicitly opt in** (still paper quotes; no fills):

```sh
node sdk/market-maker/examples/two-sided.mjs --live-data --mint=<SOL-market-mint> --ticks=3
```

Only 1–10 ticks are allowed; a run ends after at most three minutes. Ctrl-C/SIGTERM
cancels data requests and all paper quotes. `--live`/wallet/key options are rejected.
Missing liquidity, high/unknown fees, stale data, exhausted capital or limits stop
quoting rather than weakening a limit. No production secret is needed or accepted.

## Read and follow public data

After installing a built tarball (see release section):

```ts
import { MarketDataClient, type LiquiditySnapshot } from '@repoing/market-maker';

// Real network reads require explicit opt-in. For tests, inject a fixture fetch.
const data = new MarketDataClient({
  liveData: true,
  observe: event => console.log(JSON.stringify(event)),
});
const board = await data.board(); // capped, hourly samples; NOT a market registry
const mint = board.markets[0]?.mint;
if (!mint) throw new Error('No sampled SOL markets');
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
try {
  for await (const snapshot of data.watchLiquidity(mint, { signal: stop.signal })) {
    const value: LiquiditySnapshot = snapshot;
    console.log(value.liquidity.checkedAt, value.liquidity.depth);
  }
} finally {
  // If connected to your paper session, call maker.stop() here.
}
```

Methods: `board()`, `calendar()`, `events(query)`, `transparency(mint)`,
`liquidity(mint)`, `iterateEvents(query)`, `watchLiquidity(mint, options)`. All
requests accept `signal`. Runtime schemas and inferred TypeScript types are
exported. Unknown additive fields are ignored, required fields are validated,
API-version mismatches fail closed. Amounts and event IDs remain strings; use
`BigInt`, not `Number`, for arithmetic. Report subdocuments are typed as unknown
facts, not execution inputs. Browser support is not promised (the version header
is not currently exposed by CORS).

`watchLiquidity` polls every 15 seconds (minimum 10 seconds), never overlaps reads,
suppresses repeated timestamps, and follows consumer backpressure. It rejects
snapshots older than 45 seconds, over 5 seconds in the future, or older than the
previous snapshot. Errors terminate the iterator: cancel quotes and investigate;
do not keep using the last price. Pass an AbortSignal to interrupt a pending
request or wait; calling iterator `return()` alone does not interrupt a pending
`next()`. Direct `liquidity()` returns the timestamp for callers with different
freshness requirements; it does not itself impose an age policy.

### Forward event pagination, without skipped pages

```ts
let checkpoint = '0'; // Replace with your durable, successfully processed ID.
for await (const event of data.iterateEvents({
  after: checkpoint, kinds: ['market.launched', 'market.graduated'], limit: 200,
  maxPages: 100, signal: stop.signal,
})) {
  await handleIdempotently(event); // Your application; deduplicate by event.id.
  await saveCheckpoint(event.id);  // Persist AFTER processing, atomically if possible.
  checkpoint = event.id;
}
```

Each drain requests ascending IDs until an empty page; short pages are not assumed
final. Filters persist across pages. `next` is not followed as a URL. IDs must
increase strictly within/across pages; repeated/regressing cursors fail closed.
Hitting `maxPages` raises a `limit` error, never silently truncates. Resume from
your last successfully processed ID. Poll another drain after at least 15 seconds.
Changing filters requires reconsidering the checkpoint; previously filtered-out
events cannot be recovered by continuing from a newer ID. `events()` without
`after` deliberately retains the server's newest-first semantics; do not use it
to backfill. Board/calendar have no pagination; never invent a cursor for them.

### Transport, metrics and operational limits

- GET-only, HTTPS origins, no credentials/cookies, no redirects or caller-supplied
  authentication headers. There is no general POST escape hatch. An injected
  `fetch` is trusted application code; use fixture-only fetch when not opting in.
- One shared client serializes reads, pacing starts at least 2.1 seconds apart.
  This is per client, not distributed rate limiting. Reuse it and coordinate other
  processes behind the same address.
- Default 30-second **total** deadline covers queue time, network, streamed body,
  backoff and retries. Up to 100 pending calls, 2 MB per response, two retries.
  Upper bounds: five retries, five-minute deadline, 10 MB response.
- Retry only transport failures before a response and HTTP 408/429/500/502/503/504.
  Exponential jittered backoff respects the larger of the local delay and server
  `Retry-After` (seconds or HTTP date). Cooldown persists after retry exhaustion.
  If it exceeds the deadline, fail instead of retrying early. Partial body
  failures, malformed JSON, schema/version errors and other 4xx do not retry.
- `MarketDataError.code`: `http`, `network`, `timeout`, `aborted`, `contract`,
  `limit`, `stale`; `status` is present for HTTP errors. Invalid caller arguments
  throw validation/range errors. Iterator wait cancellation uses AbortSignal's
  reason. Never decide trading safety from an error's human-readable string.
- `data.metrics` returns counters for attempts/retries/errors/published snapshots.
  `observe` provides structured request/response/retry/error/snapshot events and
  request latency on responses/errors. Log callbacks
  cannot break reads. No raw bodies, URLs, wallet IDs or credentials are emitted
  by transport telemetry. Supply your own metrics backend; alert on rate limits,
  repeated failures, freshness failures and paper kill switches.

## Paper quoting and risk controls

`PaperMarketMaker` requires an explicit mint, controller identity, starting cash,
inventory, and inventory cap. Call `update(snapshot, now)` to cancel/replace quotes,
and `fill({id, quoteId, counterpartyController, tokenBaseUnits, now})` only for an
explicit independent tape event. It has no I/O, wall clock or randomness. The same
ordered inputs produce the same quotes, balances, fees and P&L. Amounts are bigint;
time is monotonic integer milliseconds. Returned quotes/metrics are copies.

Limits (intentionally conservative):

| Control | Default / hard bound |
| --- | --- |
| Starting cash | Required; at most 10 SOL of fictional capital |
| Inventory cap | Required; at most 10¹⁵ token base units; no shorting |
| Per quote notional | At most 0.1 SOL and 1% of the corresponding reported 2% depth |
| Session turnover | At most 1 SOL cumulative, never reset by replacing quotes |
| Drawdown | Default 0.1 SOL from peak marked equity; configurable up to 1 SOL |
| Half-spread | Default 200 bps; 1–2000 bps |
| Paper fee | Default 100 bps; 0–500; reject snapshot fees above the configured fee |
| Quote age | At most 45 seconds from snapshot timestamp, not receipt time |
| Fills | At most 10,000 per session, unique IDs |

Like the data feed, the paper engine permits at most five seconds of server clock
lead; larger future timestamps stop quoting. Source timestamps are never rewritten.

No leverage. A side is omitted when inventory/cash cannot support it. Buys round
cost up, sells round proceeds down, fees round up. Every accepted fill cancels
**both** quotes. Stale/bad snapshots, expiry, drawdown and session exhaustion latch
a stop; restarting requires an intentional new session. Use `stop(reason)` on
any external error. A valid fill can cross the drawdown threshold, after which the
engine stops; the bound is not a guaranteed worst-case market loss.

Paper quotes are hypothetical resting prices around AMM spot. They are **not**
AMM swap quotes, LP positions, executable orders or evidence of future profit.
Synthetic fills have no queue, adverse selection, latency, slippage, priority fees,
rent, failed transactions or MEV model. Fee estimates are a configured conservative
paper assumption, not an execution quote. P&L marks inventory at snapshot spot and
is not realizable liquidation value. Live-data examples never manufacture fills.

## Market-integrity policy

**Self-trades, circular volume, wash trading, coordinated counterparty fills,
hidden preferential access, and custody of user keys are prohibited.** Do not
adapt this SDK to fabricate turnover, farm rewards, conceal common ownership,
evade rate limits, bypass access rules, or misrepresent simulation as real trades.

The paper engine rejects its own controller and declared related controllers;
there is no internal bid/ask matching. Controller labels are caller assertions,
not an identity oracle: undeclared common control and collusion cannot be detected
from public snapshots. No SDK can certify market integrity from these APIs alone.
For any future live integration, require independent venue/transaction review,
explicit per-session opt-in, external user-controlled signing, verified ownership
and counterparty controls, strict limits and a kill switch. Never add secret-key
parameters or automatic AMM buy/sell loops. LP incentives are unpaid previews;
volume never qualifies.

## Build, conformance and release candidates

```sh
# Standalone package tests, no service credentials or external API calls:
npm --prefix sdk/market-maker test

# Repository conformance (install root dependencies first):
npm ci --ignore-scripts
node --experimental-vm-modules --test sdk/market-maker/conformance/*.test.mjs

# Build + test + allowlisted tarball, no registry publication:
npm pack ./sdk/market-maker --pack-destination /tmp
npm install /tmp/repoing-market-maker-0.1.0.tgz
```

The dedicated GitHub workflow runs Node 22/24 tests and conformance, packs a
candidate, installs it into an independent consumer, checks shipped declarations
and runs the installed simulation. The tarball contains only `dist`, examples,
README, audit, license and package metadata. CI uploads it as an artifact. It has
read-only repository permissions and **no publish token or publish step**.

Registry publication is a separate maintainer approval: choose/verify ownership
of the npm scope, review API/semver and the packed file list, then publish the
reviewed candidate through the organization's approved release process. This
change does not claim an npm release, endorsement, funded incentives, or live
trading readiness. Compatibility changes require updating the audit, schema and
conformance tests together; do not weaken version checks to ignore drift.
