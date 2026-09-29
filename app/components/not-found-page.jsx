import Link from 'next/link'
import { AppHeader, Footer } from './ui'

export const notFoundMetadata = { title: 'Page not found — repo.ing' }

export function NotFoundPage() {
  return <><AppHeader/><main className="section-wrap route-loading"><div className="page-intro"><div className="eyebrow">404</div><h1>This page isn’t on the market.</h1><p>The link may be mistyped, or the repository or market doesn’t exist yet.</p>
    <div className="not-found-actions"><Link href="/explore" className="button primary">Explore markets</Link><Link href="/launch" className="button outline">Launch a repository</Link></div></div></main><Footer/></>
}
