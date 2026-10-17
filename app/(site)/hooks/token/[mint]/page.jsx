import Link from 'next/link'
import { PublicKey } from '@solana/web3.js'
import { notFound } from 'next/navigation'
import { HooksIntro, HooksRisk, HooksUnavailable } from '../../../../components/hooks-ui'

export const metadata = { title: 'Hook coin — repo.ing', robots: { index: false } }

export default async function HooksTokenPage({ params, searchParams }) {
  const { mint } = await params
  try { if (new PublicKey(mint).toBase58() !== mint) notFound() } catch { notFound() }
  const rules = (await searchParams)?.tab === 'rules'
  return <><Link className="back-link" href="/hooks">← Hooks markets</Link><HooksIntro title="Unverified coin" art="find-repo">An address alone does not establish a market, network or supported rules.</HooksIntro>
    <p className="hooks-address">Requested address <code>{mint}</code></p>
    <nav className="hooks-nav" aria-label="Coin details"><Link href={`/hooks/token/${mint}`} aria-current={!rules ? 'page' : undefined}>Market</Link><Link href={`/hooks/token/${mint}?tab=rules`} aria-current={rules ? 'page' : undefined}>Rules &amp; curve</Link></nav>
    <div className="hooks-token-grid"><section className="hooks-card hooks-empty"><img src="/launch-icons/find-repo.webp" width={72} height={72} alt=""/>
      <h2>{rules ? 'Rules and curve are unverified' : 'Market data unavailable'}</h2><p>{rules ? 'No decoded, verified rules or reserve data is available for this address. Do not assume it is a plain coin.' : 'No verified price history, balances or trades are available for this address. No chart or market metrics can be shown.'}</p>
      <Link href="/hooks" className="button">Return to Hooks</Link>
    </section><aside className="hooks-card"><h2>Buy / Sell</h2><HooksUnavailable title="Trading unavailable">There is no executable quote, simulation or supported public trading path. Connecting a wallet will not change this.</HooksUnavailable><div className="hooks-trade-actions"><button className="button primary" disabled>Buy unavailable</button><button className="button" disabled>Sell unavailable</button></div><p className="hooks-fine">No transaction has been prepared by this page.</p></aside></div><HooksRisk/>
  </>
}
