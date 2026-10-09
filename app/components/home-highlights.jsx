import Link from 'next/link'
import { platformTotals } from '../lib/platform-totals.mjs'
import { buybackReceipts } from '../lib/buyback-feed.mjs'
import { proofFacts } from '../lib/home-highlights.mjs'

// Home hero, under the launch box: what the platform has done, as figures. Shared cached reads (totals 5 min, buybacks 30 s).
export async function HomeProof() {
  const [totals, receipts] = await Promise.all([platformTotals(), buybackReceipts()])
  return <HomeProofLine facts={proofFacts({ totals, receipts })}/>
}

// detail: a second, smaller line under a figure's label (the builder payouts' outside-builders part).
export function HomeProofLine({ facts }) {
  return <p className="home-proof">{facts.map(fact => <span key={fact.id}>
    {fact.href ? <Link href={fact.href}><strong>{fact.value}</strong> {fact.label}</Link> : <><strong>{fact.value}</strong> {fact.label}</>}
    {fact.detail && <small>{fact.detail}</small>}</span>)}</p>
}

// Same box as the resolved line, so the figures stream in without moving anything below.
export const HomeProofFallback = () => <p className="home-proof is-loading" aria-hidden="true"><span className="skeleton-line"/></p>
