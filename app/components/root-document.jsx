import '../globals.css'
import '../theme.css'
import '../tips.css'
import '../parts-fund.css'
import '../holder-notes.css'
import '../x-links.css'
import '../backers.css'
import '../trust-panel.css'
import '../art.css'
import { WalletProvider } from './wallet'
import { WatchlistProvider } from './watchlist'
import { THEME_SCRIPT } from '../lib/theme-script.mjs'
import { siteJsonLd } from '../lib/json-ld.mjs'
import { JsonLd } from './json-ld'
import { WebVitals } from './web-vitals'
import { ReferralCapture } from './referral-capture'
import { connection } from 'next/server'

// Only what is not working yet, in plain words (owner, 2026-10-26). Empty, and so no banner, while everything works
// (owner 2026-10-27: no banner for bundles).
export function recoveryNotice(ordinaryLaunches) {
  return [
    ordinaryLaunches ? null : 'New launches are paused.',
  ].filter(Boolean).join(' ')
}

// /ja has its own root layout (route group) so it can render <html lang="ja">.
export async function RootDocument({ lang, children }) {
  // Recovery policy is supplied at runtime, not at image-build time. Render the
  // warning inside React so hydration and client navigation cannot remove it.
  await connection()
  const tradingRecovery = process.env.EXISTING_MARKET_TRADING_ONLY === 'true' && process.env.EXISTING_MARKET_TRADING_STAGE === 'live'
  const notice = tradingRecovery ? recoveryNotice(process.env.ORDINARY_LAUNCH_RECOVERY_ENABLED === 'true') : ''
  return <html lang={lang} data-scroll-behavior="smooth" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}/><JsonLd data={siteJsonLd(lang)}/></head><body style={notice ? { paddingBottom: 80 } : undefined}><WebVitals/><ReferralCapture/><WalletProvider><WatchlistProvider>{children}</WatchlistProvider></WalletProvider>
    {notice && <aside role="note" id="recovery-notice" style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 2147483647, padding: '10px 16px', background: '#fff3cd', color: '#332500', borderTop: '1px solid #b89b46', font: '600 13px/1.4 system-ui', textAlign: 'center' }}>{notice}</aside>}
  </body></html>
}
