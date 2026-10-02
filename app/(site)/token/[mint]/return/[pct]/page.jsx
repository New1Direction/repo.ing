import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { AppHeader, Footer } from '../../../../../components/ui'
import { marketByMint } from '../../../../../lib/server.mjs'
import { formatReturn, parseReturnParam, returnPageUrl, tokenPageUrl } from '../../../../../lib/share-links.mjs'
import { HF_DISCLAIMER, HF_DISCLAIMER_SHORT, isModelMarket } from '../../../../../lib/hf-model-display.mjs'
import { hfMarketsEnabled } from '../../../../../lib/hf-markets.mjs'

// Landing page for a shared return: it exists so X unfurls the return card, then sends people to trade.
// The URL carries only { mint, pct } and is labelled as the sharer's own report, never verified.
export const dynamic = 'force-dynamic'

// A Hugging Face model market's return page exists only with HF_MARKETS_ENABLED, and carries the disclaimer.
async function sharedMarket(params) {
  const { mint, pct: raw } = await params
  const pct = parseReturnParam(raw)
  const { market: found } = await marketByMint(mint)
  const model = Boolean(found) && isModelMarket(found)
  return { mint, pct, model, market: model && !hfMarketsEnabled() ? null : found }
}

export async function generateMetadata({ params }) {
  const { pct, market, model } = await sharedMarket(params)
  if (!market || pct === null) return { title: 'repo.ing', robots: { index: false } }
  const title = `My return on $${market.symbol}: ${formatReturn(pct)} — repo.ing`
  const description = model ? `A trader's reported return on the Hugging Face model market ${market.fullName}. ${HF_DISCLAIMER_SHORT}.`
    : `A trader's reported return on ${market.fullName}. Every trade pays the repo's builders in SOL.`
  const url = returnPageUrl(market.mint, pct)
  const image = { url: `${url}/image`, width: 1200, height: 630, alt: `Reported return of ${formatReturn(pct)} on $${market.symbol} (${market.fullName}) on repo.ing` }
  return { title, description, robots: { index: false }, alternates: { canonical: tokenPageUrl(market.mint) },
    openGraph: { title, description, url, type: 'website', siteName: 'repo.ing', images: [image] },
    twitter: { card: 'summary_large_image', title, description, images: [image] } }
}

export default async function SharedReturn({ params }) {
  const { mint, pct, market, model } = await sharedMarket(params)
  if (!market) notFound()
  if (pct === null) redirect(`/token/${market.mint}`)
  const tone = pct > 0 ? 'gain' : pct < 0 ? 'loss' : ''
  return <><AppHeader/><main className="section-wrap return-share-page">
    <section className="inner-card return-share" aria-labelledby="return-heading">
      <p className="eyebrow">Shared return</p>
      <h1 id="return-heading">My return on ${market.symbol}<strong className={tone}>{formatReturn(pct)}</strong></h1>
      {model ? <p className="muted">{market.fullName} · reported by the person who shared this link, not verified by repo.ing. Every trade pays the model’s owner in SOL. {HF_DISCLAIMER}</p>
        : <p className="muted">{market.fullName} · reported by the person who shared this link, not verified by repo.ing. Every trade pays the repo’s builders in SOL.</p>}
      <div className="wallet-market-actions"><Link className="button primary" href={`/token/${mint}`}>Trade ${market.symbol}</Link><Link className="button outline" href="/explore">Explore markets</Link></div>
    </section>
  </main><Footer/></>
}
