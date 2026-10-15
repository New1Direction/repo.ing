import Link from 'next/link'
import { AppHeader, Footer } from '../../../components/ui'
import { DirectCoinPlanner } from '../../../components/direct-coin-planner'
import '../../../direct-coins.css'

export const metadata = { title: 'Plan a direct coin · repo.ing', description: 'Compare Standard and Programmable coins. Devnet planning only; no transactions or funds.', robots: { index: false } }
export default async function DirectCoinsPage({ searchParams }) {
  const { lane } = await searchParams ?? {}
  const initialLane = ['standard', 'programmable'].includes(lane) ? lane : undefined
  return <><AppHeader active="launch"/><main className="direct-coins">
    <Link href="/launch" className="back-link">← Repository launches</Link>
    <header className="coin-intro"><span className="badge">Preview only · no funds</span>
      <h1>A coin. Two different paths.</h1><p>Plan your own coin: Standard on Raydium/Meteora, or Programmable on
        Hook Lab’s native launch and trading stack inside repo.ing. This is not a Hook Lab platform token,
        and this preview moves no funds.</p></header>
    <DirectCoinPlanner key={initialLane ?? 'resume'} initialLane={initialLane}/>
  </main><Footer/></>
}
