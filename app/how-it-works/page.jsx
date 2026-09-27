import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { AppHeader, Footer } from '../components/ui'

export const metadata = { title: 'How it works — repo.ing', description: 'Find a repo, launch its token, trade, and claim repo earnings.' }

const steps = [
  { number: '01', title: 'Find a repo', body: 'Paste a public GitHub repo link. If its token already exists, we’ll take you to its market.' },
  { number: '02', title: 'Launch a token', body: 'If there is no token yet, choose a name and ticker. Connect your Solana wallet and approve the launch.' },
  { number: '03', title: 'Buy or sell', body: 'Trade on the token’s market page. Your wallet approves each trade, and part of the trade fee is set aside for the repo.' },
  { number: '04', title: 'Claim earnings', body: 'A current repo admin signs in with GitHub, signs with a payout wallet, and claims the fees earned by the repo.' },
]

export default function HowItWorks() {
  return <><AppHeader active="how-it-works"/><main className="section-wrap info-page">
    <section className="info-intro"><div className="eyebrow">HOW IT WORKS</div><h1>From repository<br/><span>to market.</span></h1><p>Find a public repo, launch its token, trade, and let the repo admin claim its share of fees.</p></section>
    <section className="steps-grid" aria-label="How repo.ing works">{steps.map(step => <article className="step-card" key={step.number}><span className="step-index">{step.number}</span><h2>{step.title}</h2><p>{step.body}</p></article>)}</section>
    <section id="discovery" className="inner-card discovery-explainer"><h2>Discover a repo. Earn a share.</h2><p>The wallet that launches a new market earns 50% of repo.ing’s partner trading fees until graduation, 30 days, or 2.5 SOL earned—whichever comes first. Earlier enrolled markets keep their original 1 SOL cap. Markets without discovery rewards are not enrolled retroactively.</p><p>Rewards come from repo.ing’s existing share; builder fees stay the same. Earned rewards remain claimable after the earning period ends. Find them under My wallet or on the market page. Your wallet pays network and account setup costs when claiming.</p><Link className="button outline" href="/wallet">My holdings & rewards</Link></section>
    <section className="info-closing"><div><h2>Ready to try it?</h2><p>Paste a repo link on the home page, or browse tokens already trading.</p></div><div className="info-actions"><Link href="/" className="button primary">Start with a repo <ArrowRight size={18}/></Link><Link href="/explore" className="button outline">Explore markets</Link></div></section>
  </main><Footer/></>
}
