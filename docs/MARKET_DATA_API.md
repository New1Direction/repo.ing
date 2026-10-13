# Market data API

[Documentation](README.md) / Market data API

Public, read-only, cookie-free JSON for launch calendars, market makers and researchers (version `2026-10-13`, in the `X-Repoing-Api-Version` header). The `/api/v1` endpoints:

- answer any origin (`Access-Control-Allow-Origin: *`);
- carry edge cache headers;
- give errors as `{ "error": "…" }` with `no-store`.

Amounts are decimal strings in base units: lamports for SOL (10⁹ per SOL) and token base units (10⁶ per token). Methodology: [Launch transparency](LAUNCH_TRANSPARENCY.md). Nothing here is advice, an offer, or a promise about execution.

| Endpoint | Edge cache | What |
| --- | --- | --- |
| `GET /api/v1/launches` | 30 s | [Launch calendar](#launch-calendar) |
| `GET /api/v1/launches/events` | 15 s | [Launch feed](#launch-feed) events, pollable with `?after=` |
| `GET /launches.atom` | 60 s | The same feed as Atom |
| `GET /launches.ics` | 300 s | [Calendar subscription](#calendar-subscription) |
| `GET /api/v1/markets/<mint>/transparency` | 60 s | [Market transparency](#market-transparency) report |
| `GET /api/v1/markets/<mint>/liquidity` | 10 s | [Live liquidity](#liquidity) from the pool now |
| `GET /api/v1/liquidity` | 60 s | [Liquidity board](#liquidity-board): every market's latest hourly sample |
| `GET /api/v1/webhooks/signing-key` | 1 h | [Webhook](#webhooks) verification key (404 while webhooks are off) |

The read-only MCP server (`/api/mcp/readonly`, [plugin](../plugins/repo-ing/README.md)) is unchanged.

## Launch calendar

`GET /api/v1/launches` returns `{ generatedAt, scheduled, groupLaunches, recentLaunches }`:

- **`scheduled[]`:** announced launches not yet past their window, soonest first.
  - Fields: `id`, `repoId`, `fullName`, `state`, `scheduledAt`, `windowEndsAt`, `windowMinutes`, `launcherWallet`, `maxInitialBuyLamports`, `note`, `announcedBy`, `announcedAt`.
  - `state` is `upcoming` or `open`.
  - During the window only `launcherWallet` can launch, with an initial buy of at most `maxInitialBuyLamports`.
- **`groupLaunches[]`:** Group launch raises still raising. Fields: `bundleId`, `repoId`, `fullName`, `symbol`, `targetLamports`, `deadline`, `path`.
- **`recentLaunches[]`:** markets launched in the last 7 days, newest first.
  - Fields: `repoId`, `mint`, `symbol`, `launcherWallet`, `launchedAt`, `groupLaunch`, `path`, `quality`.
  - `quality` is `{ score | null, coveragePercent, assessedAt, unknowns, flags }`, or `null` before the first assessment.

Repositories repo.ing does not promote (the do-not-promote list and maintainer decisions) are left out.

## Launch feed

`GET /api/v1/launches/events` returns `{ events, kinds, next }`. Each event has these fields:

- `id`: increasing.
- `kind`.
- `repoId`.
- `occurredAt`: when it happened.
- `recordedAt`: when the feed saw it.
- `data`: the facts. `data.path` is a relative link.

| Kind | When | `data` |
| --- | --- | --- |
| `launch.scheduled` | A maintainer announced a launch | `fullName`, `schedule` |
| `launch.schedule_cancelled` | It was cancelled | `fullName`, `schedule` |
| `launch.window_open` | Its time arrived | `fullName`, `schedule` |
| `launch.schedule_lapsed` | Its window passed without a launch | `fullName`, `schedule` |
| `market.launched` | A market's finalized launch was indexed | `mint`, `symbol`, `name`, `launcherWallet`, `groupLaunch`, `signature` |
| `market.graduated` | The verified migration to DAMM v2 was recorded | `mint`, `symbol`, `pool`, `signature` |
| `group_launch.raising` / `.launched` / `.failed` | A Group launch raise opened, launched, or failed or expired | `bundleId`, `symbol`, `targetLamports`, `deadline` |

Parameters:

- `?limit=1..200` (default 50).
- `?kind=a,b` and `?repo=<ids>` (up to 50).
- `?after=<id>` returns the next events in increasing id order.

Without `after`, the newest come first. To follow the feed, keep the largest `id` you processed and poll `?after=<id>`; `next` is that query for the current page.

## Calendar subscription

`GET /launches.ics` is an iCalendar (RFC 5545) file with:

- each scheduled launch window, with a 15-minute alarm;
- each Group launch deadline.

Subscribe to the URL in a calendar app and its reminders become the notification. `?repos=<ids>` keeps only those repositories; each listing's "Add to calendar" link on `/launches` uses it.

## Market transparency

`GET /api/v1/markets/<mint>/transparency` returns:

| Field | Content |
| --- | --- |
| `market` | `repoId`, `mint`, `pool`, `symbol`, `fullName` |
| `report` | The worker's latest report (`null` before the first): `version`, `assessedAt`, `score` (null below 60% coverage), `coveragePercent`, `unknowns`, `flags`, `criteria[]`, `excludedInputs`, `disclosures`, `integrity`, `health`, `incentives` (graduated pools only) |
| `report.criteria[]` | `{ id, group, label, status: pass|warn|fail|unknown|info, points, max, value, evidence: [{ source, ref, observedAt }], note }` |
| `report.integrity` | `totals` in lamports (`volume`, `organic`, `roundTrip`, `sameTransaction`, `labeled`, `unattributed`), percentages of attributed volume, `traders`, and the ten largest `flagged` controllers |
| `report.health` | `diversity`, `retention`, `liquidity` (30-day sustained figures), `builderReward` (preview: `status: "preview"`, `paid: false`) |
| `report.incentives` | LP providers with `timeWeightedSharePercent`, `uptimePercent`, `exclusion`, `incentiveSharePercent` (preview, `paid: false`) |
| `liquidity` | The latest hourly sample (see below) |
| `seeded` | Seeded positions: `kind`, `label`, `wallet`, `solLamports`, `tokenBaseUnits`, `percentOfSupply`, `lock`, `lockText`, `evidence` |
| `mechanism` | `stages[]` (`id`, `title`, `status: done|active|upcoming|skipped`, `facts[]`, `evidence`) and `notLive[]` |
| `schedule` | The schedule the market launched under, if any |
| `disclosures` | Risk statements |

## Liquidity

`GET /api/v1/markets/<mint>/liquidity` reads the pool now: a DBC curve before graduation, or the verified DAMM v2 pool after it. It returns one snapshot, cached 10 s per process and limited per address:

| Field | Meaning |
| --- | --- |
| `venue` | `curve` or `damm` |
| `sqrtPrice`, `lamportsPerToken` | Spot (Q64 sqrt price; SOL lamports per whole token) |
| `feeBps` | Fee a small buy pays now (higher during a launch fee window) |
| `depth[]` | For 1%, 2% and 5%: `buyLamports`, the largest SOL buy whose average price before fees stays within that distance of spot, and the `buyTokens` it returns; `sellTokens` and `sellLamports` likewise for sells |
| `spreads[]` | At 0.1 and 1 SOL: `askToSpotPpm` and `bidToSpotPpm` (average prices over spot, ×10⁶), and `spreadBps`, the cost of buying that size and selling the same spot value back now, fees included; `null` when one side cannot be quoted |
| `quoteReserveLamports` | SOL in the curve or pool |
| `thresholdLamports` | The curve's graduation target (curve only) |
| `summary` | The stored-sample summary: 2% depth each side, 0.1 SOL spread, `twoSided` |

Quotes are the Meteora SDK's exact integer quotes on that snapshot. The validator test executes swaps of exactly the published 2% sizes and receives exactly the published amounts. Other trades change execution.

## Liquidity board

`GET /api/v1/liquidity` returns every SOL market's latest hourly sample, ordered by depth:

- `sampledAt`, `venue`, `pool`, `feeBps`, `quoteReserveLamports`;
- `buyDepthLamports` and `sellDepthLamports` within 2%;
- `spreadBps` at 0.1 SOL;
- `twoSided`;
- `sustained`: 30-day `uptimePercent`, `medianDepthLamports`, `medianSpreadBps`, `samples`, `coveragePercent`;
- for graduated pools, `incentives`.

Uptime counts a sample when both sides hold ≥ 0.1 SOL within 2% and the spread is ≤ 10%. Incentives are a preview: only LP positions qualify, volume never does, and nothing is paid.

## Webhooks

Off unless `LAUNCH_WEBHOOKS_ENABLED=true` and `LAUNCH_WEBHOOK_SIGNING_KEY` are set on web and worker.

**Subscribing:** a signed-in GitHub user adds up to five HTTPS URLs at `/launches/manage#webhooks`, optionally limited to event kinds and repository ids. A new subscription starts at the newest event; there is no backlog.

**Delivery:** the worker POSTs each matching feed event as JSON, the same object as in the events API. Headers:

- `x-repoing-event`: the kind;
- `x-repoing-event-id`;
- `x-repoing-timestamp`: Unix seconds;
- `x-repoing-signature`: `ed25519=<base64>`, the signature over `` `${timestamp}.${raw body}` ``.

Verify it with the key from `/api/v1/webhooks/signing-key` (`publicKeyBase64`, raw 32 bytes, or `pem`), and reject old timestamps.

**Retries and limits:**

- Any non-2xx answer or a 5-second timeout is retried after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours, then marked failed.
- Twenty consecutive failures pause the subscription; delete it and add it again to resume.
- URLs must be `https://` on port 443 with a public host. Every resolved address must be public, and this is checked when connecting, so DNS rebinding cannot reach private networks.
- Redirects are not followed and response bodies are discarded.

Example check in Node:

```js
import { createPublicKey, verify } from 'node:crypto'
const ok = verify(null, Buffer.from(`${req.headers['x-repoing-timestamp']}.${rawBody}`),
  createPublicKey(publishedPem), Buffer.from(req.headers['x-repoing-signature'].slice('ed25519='.length), 'base64'))
```
