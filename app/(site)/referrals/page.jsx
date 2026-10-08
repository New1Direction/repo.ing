import { Suspense } from 'react'
import Link from 'next/link'
import { ArrowRight, Coins, Repeat2, Share2 } from 'lucide-react'
import { AppHeader, Footer } from '../../components/ui'
import { ReferralDashboard } from '../../components/referral-dashboard'
import { ReferralLeaderboard, ReferralLeaderboardFallback } from '../../components/referral-leaderboard'
import { referralLeaderboard } from '../../lib/referral-board.mjs'
import '../../referrals.css'

export const metadata = { title: 'Referrals — repo.ing',
  description: 'Share repo.ing markets and earn 4% of the trading fee on every trade you bring, paid in SOL from Meteora’s protocol share.' }
// The leaderboard is read per request from a one-minute in-process memo (app/lib/referral-board.mjs).
export const dynamic = 'force-dynamic'

const STEPS = [
  { icon: Share2, title: 'Share a link', body: 'Copy your link above. Once payouts are set up, the market links, X posts and Blink links you share carry it too; the share menu says so, since the link holds your wallet address, and lets you leave it out.' },
  { icon: Repeat2, title: 'They trade', body: 'For 30 days after someone opens your link, their trades on repo.ing name you as referrer (the last link they opened wins). Buys and sells from a Blink you shared name you too.' },
  { icon: Coins, title: 'You earn 4%', body: 'Each of those trades pays you 4% of its trading fee, in SOL, the moment it lands. It is carved from Meteora’s protocol share, so it costs traders, builders and repo.ing nothing.' },
]

export default function ReferralsPage() {
  return <><AppHeader/><main className="section-wrap info-page referrals-page">
    <section className="info-intro"><div className="eyebrow">REFERRALS</div><h1>Share a market.<br/><span>Earn 4% of its fees.</span></h1>
      <p>Every trade someone makes from your link pays you 4% of the trading fee in SOL. It comes out of Meteora’s protocol share: traders pay the same fee, builders keep their full share, and repo.ing pays nothing.</p></section>
    <ReferralDashboard/>
    <section className="referral-how" aria-labelledby="referral-how-title">
      <h2 id="referral-how-title">How it works</h2>
      <ol className="referral-steps">{STEPS.map(({ icon: Icon, title, body }, index) => <li key={title} className="inner-card">
        <span className="referral-step-number" aria-hidden="true">{index + 1}</span><Icon size={20} aria-hidden="true"/><h3>{title}</h3><p>{body}</p></li>)}</ol>
      <p className="referral-fineprint">Payouts need the one-time setup above: without your wrapped-SOL account, trades from your link go through but pay no referral. For now the setup is free: you sign a message (no transaction, no SOL) and repo.ing pays for the account, once per wallet while the day’s free setups last. Otherwise you pay its small refundable deposit yourself. You cannot refer your own wallet. Meteora’s programs pay the fee straight into your wallet’s wrapped-SOL account during each swap; repo.ing never holds it.</p>
    </section>
    <section className="referral-leaderboard" aria-labelledby="referral-leaderboard-title">
      <div className="referral-leaderboard-heading"><h2 id="referral-leaderboard-title">Top referrers</h2>
        <p>Settled trades placed on repo.ing through a referral link. Earnings are estimated at 4% of each trade’s quoted fee; Blink trades signed in other apps are not counted here. Updated every minute.</p></div>
      <Suspense fallback={<ReferralLeaderboardFallback/>}><Leaderboard/></Suspense>
    </section>
    <section className="info-closing"><div><h2>Find a market worth sharing</h2><p>Every market is a public GitHub repo whose builders earn from each trade.</p></div>
      <div className="info-actions"><Link href="/explore" className="button primary">Explore markets <ArrowRight size={18} aria-hidden="true"/></Link><Link href="/how-it-works" className="button outline">How repo.ing works</Link></div></section>
  </main><Footer/></>
}

async function Leaderboard() {
  const { board, unavailable } = await referralLeaderboard()
  return board ? <ReferralLeaderboard board={board}/> : <div className="state-card" role="status">{unavailable}</div>
}
