import Link from 'next/link'
import { builderSharesSettings, cachedShareTotals } from '../../src/builder-pack-shares.mjs'
import { creditsPacksSettings } from '../../src/credits-packs.mjs'
import { isStockPairMarket } from '../../src/stock-owner-claims.mjs'
import { creditPacksAvailable } from '../lib/credit-packs.mjs'
import { isPromotionExcluded } from '../lib/promotion-exclusions.mjs'
import { database } from '../lib/server.mjs'
import { money } from './credit-packs/packs-model.mjs'
import '../pack-shares.css'

// Every pack pays a builder (src/builder-pack-shares.mjs, docs/CREDITS_WEB.md "Builder shares"): the token page card, under the
// tip jar. Dark unless the switch is on, with packs on. The market read behind the page returns confirmed, finalized, indexed
// markets only, so a GitHub market that is not a stock pair is a confirmed SOL market: the only kind the credit service has
// totals for. Never for a do-not-promote repository. Totals are budgeted (cachedShareTotals): when they cannot be read, the card
// shows without its "Paid so far" line.
export async function PackSharesCard({ market }) {
  const shares = builderSharesSettings(), settings = creditsPacksSettings()
  if (!shares || !settings || !creditPacksAvailable() || market.source !== 'github' || isStockPairMarket(market) || isPromotionExcluded(market.repoId)) return null
  const totals = await cachedShareTotals(settings, market.repoId, { pool: database() }).catch(() => null)
  const percent = shares.shareBps / 100
  return <section className="inner-card pack-shares-card" aria-labelledby="pack-shares-title">
    <h3 id="pack-shares-title">AI credit packs back this repo</h3>
    <p>{percent}% of every pack opened for {market.fullName} goes to its builders as AI credits.</p>
    {totals?.packs > 0 && <p>Paid so far: <strong>{money(totals.paidMicro)}</strong> from {totals.packs} {totals.packs === 1 ? 'pack' : 'packs'}</p>}
    <Link className="button outline" href={`/credits?repo=${market.repoId}`}>Open a pack for {market.fullName}</Link>
  </section>
}
