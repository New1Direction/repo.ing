import Link from 'next/link'

export function ExploreNavigation({ active }) {
  return <nav className="explore-navigation" aria-label="Explore sections">
    <Link href="/explore" aria-current={active === 'markets' ? 'page' : undefined}>Markets</Link>
    <Link href="/find-repos" aria-current={active === 'repos' ? 'page' : undefined}>Find repos</Link>
    <Link href="/waiting" aria-current={active === 'waiting' ? 'page' : undefined}>Waiting<span className="explore-nav-long">{"\u00a0"}for maintainers</span></Link>
  </nav>
}
