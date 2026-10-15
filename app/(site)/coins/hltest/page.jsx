import Link from 'next/link'
import { AppHeader, Footer } from '../../../components/ui'
import { HookLabAcceptance } from '../../../components/hooklab-acceptance'
import acceptance from '../../../../src/hooklab-hltest-acceptance.json'
import '../../../direct-coins.css'

export const metadata = { title: 'HLTEST devnet acceptance · repo.ing', robots: { index: false } }
export default function HltestAcceptancePage() {
  return <><AppHeader active="launch"/><main className="direct-coins">
    <Link className="back-link" href="/coins/new?lane=programmable">← Programmable Coin planner</Link>
    <header className="coin-intro"><span className="badge">Hook Lab DEX · experimental devnet beta</span>
      <h1>HLTEST acceptance</h1><p>One plain launch finalized on fresh guarded programs. Verify its recovery without connecting a wallet or moving funds.</p></header>
    <HookLabAcceptance identity={{ mint: acceptance.preview.mint, signature: acceptance.signature,
      finalizedSlot: acceptance.finalizedSlot, messageSha256: acceptance.preview.preview.messageSha256,
      swap: acceptance.identities.swap, launch: acceptance.identities.launch }}/>
  </main><Footer/></>
}
