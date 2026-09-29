import '../globals.css'
import '../theme.css'
import { WalletProvider } from './wallet'
import { WatchlistProvider } from './watchlist'
import { THEME_SCRIPT } from '../lib/theme-script.mjs'

// /ja has its own root layout (route group) so it can render <html lang="ja">.
export function RootDocument({ lang, children }) {
  return <html lang={lang} data-scroll-behavior="smooth" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}/></head><body><WalletProvider><WatchlistProvider>{children}</WatchlistProvider></WalletProvider></body></html>
}
