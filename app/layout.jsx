import './globals.css'
import './theme.css'
import { WalletProvider } from './components/wallet'
import { WatchlistProvider } from './components/watchlist'
export const metadata = { metadataBase: new URL('https://repo.ing'), title: 'repo.ing — Open source markets', description: 'Launch and trade tokens for public GitHub repositories.' }
export default function RootLayout({ children }) { return <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: "try{document.documentElement.dataset.theme=localStorage.getItem('gitfun-theme')==='light'?'light':'dark'}catch{document.documentElement.dataset.theme='dark'}" }}/></head><body><WalletProvider><WatchlistProvider>{children}</WatchlistProvider></WalletProvider></body></html> }
