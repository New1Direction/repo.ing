// SOL/USD for USD-priced Hooks launches. The owner's invite reads every source fresh; the creator page shows a
// cached estimate. Neither touches app/lib/sol-usd.mjs, which keeps its first-answer price for the rest of the site.
import { readSolUsdSources } from '../../src/sol-usd-sources.mjs'
import { launchVirtualQuote, solUsdQuorum } from '../../src/hooklab-launch-pricing.mjs'

// The price fixed at invite: the median of at least two agreeing sources, refused outside the on-chain bounds.
export async function launchPriceAtInvite(fetchImpl = fetch) {
  const quorum = solUsdQuorum(await readSolUsdSources(fetchImpl))
  return { ...quorum, virtualQuote: launchVirtualQuote(quorum.solUsdMicros) }
}

const ESTIMATE_MS = 60_000, RETRY_MS = 30_000
let estimate = null, expiresAt = 0, pending = null
// The creator's "at today's price" figures, read at most once a minute (the request page polls every 5 seconds).
// null while sources fail, disagree or fall outside the bounds; the page then shows the USD targets alone.
export function launchPriceEstimate(fetchImpl = fetch, now = Date.now()) {
  if (now < expiresAt) return Promise.resolve(estimate)
  pending ??= launchPriceAtInvite(fetchImpl).then(({ solUsdMicros, virtualQuote }) => ({ solUsdMicros, virtualQuote }), () => null)
    .then(value => { estimate = value; expiresAt = now + (value ? ESTIMATE_MS : RETRY_MS); return value })
    .finally(() => { pending = null })
  return pending
}
