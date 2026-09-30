import '../globals.css'
import '../theme.css'
import '../tips.css'
import '../parts-fund.css'
import '../parts-browse.css'
import '../holder-notes.css'
import '../x-links.css'
import { WalletProvider } from './wallet'
import { WatchlistProvider } from './watchlist'
import { THEME_SCRIPT } from '../lib/theme-script.mjs'
import { siteJsonLd } from '../lib/json-ld.mjs'
import { JsonLd } from './json-ld'

// /ja has its own root layout (route group) so it can render <html lang="ja">.
export function RootDocument({ lang, children }) {
  return <html lang={lang} data-scroll-behavior="smooth" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}/><JsonLd data={siteJsonLd(lang)}/></head><body><WalletProvider><WatchlistProvider>{children}</WatchlistProvider></WalletProvider></body></html>
}
