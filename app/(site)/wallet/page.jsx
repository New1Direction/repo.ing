import { AppHeader, Footer } from '../../components/ui'
import { WalletOverview } from '../../components/wallet-overview'
import { MyTips } from '../../components/my-tips'
import { tipsEnabled } from '../../lib/tips.mjs'
import { XAccount } from '../../components/x-account'
import { xLinksEnabled } from '../../lib/x-links.mjs'
export const metadata = { title: 'My holdings & rewards — repo.ing', robots: { index: false, follow: false } }
export const dynamic = 'force-dynamic'
export default function WalletPage() {
  return <><AppHeader active="wallet"/><main className="section-wrap wallet-page"><div className="section-heading"><div><div className="eyebrow">YOUR WALLET</div><h1>My holdings & rewards</h1><p className="muted">Your repo.ing tokens, launched markets, and rewards in one place.</p></div></div>{xLinksEnabled() && <XAccount/>}<WalletOverview/>{tipsEnabled() && <MyTips/>}</main><Footer/></>
}
