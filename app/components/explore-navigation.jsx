import Link from 'next/link'

export function ExploreNavigation({ active }) {
  return <nav className="explore-navigation" aria-label="Explore sections">
    <Link href="/explore" aria-current={active === 'markets' ? 'page' : undefined}>Markets</Link>
    <Link href="/find-repos" aria-current={active === 'repos' ? 'page' : undefined}>Find repos</Link>
  </nav>
}
