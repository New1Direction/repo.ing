'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Activity, Search, Eye } from 'lucide-react'
import { MarketTable } from './ui'
import { orderMarkets } from '../lib/market-order.mjs'
import { orderByShipping } from '../lib/pulse-rank.mjs'
import { MARKET_CATEGORIES, marketCategories } from '../lib/market-categories.mjs'
import { PROMOTION_MIN_PERCENT } from '../lib/repo-quality.mjs'
import { useWatchlist, WatchlistSettings } from './watchlist'

export function ExploreList({ markets, usdPerSol }) {
  const router = useRouter(), params = useSearchParams()
  const tab = ['new', 'shipping', 'watchlist'].includes(params.get('view')) ? params.get('view') : 'trending'
  const category = MARKET_CATEGORIES.some(c => c.id === params.get('category')) ? params.get('category') : 'all'
  const ownership = ['verified', 'unverified', 'official'].includes(params.get('owner')) ? params.get('owner') : 'all'
  const [query, setQuery] = useState('')
  const { state, ready, storageError } = useWatchlist()
  const searchInput = useRef(null)
  function filter(key, value) {
    const next = new URLSearchParams(params.toString())
    if (value === 'all' || value === 'trending') next.delete(key); else next.set(key, value)
    router.replace(`/explore${next.size ? `?${next}` : ''}`, { scroll: false })
  }
  useEffect(() => {
    function focusSearch(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchInput.current?.focus() }
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [])
  const categorized = useMemo(() => markets.map(m => ({ ...m, categories: marketCategories(m) })), [markets])
  const shown = useMemo(() => {
    let rows = categorized.filter(m => `${m.fullName} ${m.symbol} ${m.tokenName}`.toLowerCase().includes(query.toLowerCase()))
    if (ownership === 'official') rows = rows.filter(m => m.officialLaunch)
    else if (ownership !== 'all') rows = rows.filter(m => Boolean(m.wasVerified) === (ownership === 'verified'))
    if (category !== 'all') rows = rows.filter(m => m.categories.includes(category))
    if (tab === 'watchlist') rows = rows.filter(m => state.items.some(item => item.repoId === m.repoId))
    return tab === 'shipping' ? orderByShipping(rows) : orderMarkets(rows, tab === 'new' ? 'New' : 'Trending')
  }, [categorized, ownership, category, tab, query, state.items])
  const empty = tab === 'watchlist' && !state.items.length ? 'Watch a repository to keep it here. Use the eye button beside any market.' : 'No repositories match these filters.'
  return <>
    <div className="explore-search"><Search size={20}/><input ref={searchInput} aria-label="Search markets" placeholder="Search repositories or tokens..." value={query} onChange={e => setQuery(e.target.value)}/><kbd>⌘ K</kbd></div>
    <div className="discovery-controls"><div className="discovery-tabs" aria-label="Market views">
      {[['trending','Trending'],['shipping','Shipping'],['new','New'],['watchlist','Watchlist']].map(([value,label]) => <button type="button" key={value} aria-pressed={tab === value} onClick={() => filter('view',value)}>{value === 'watchlist' && <Eye size={15}/>}{value === 'shipping' && <Activity size={15} className="shipping-tab-icon"/>} {label}{value === 'watchlist' && ready && <span className="count-badge">{state.items.length}</span>}</button>)}
    </div><div className="discovery-filters">
      <label><span className="sr-only">Category</span><select aria-label="Repository category" title="Categories use repository names and descriptions" value={category} onChange={event => filter('category',event.target.value)}><option value="all">All categories</option>{MARKET_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label} ({categorized.filter(m => m.categories.includes(c.id)).length})</option>)}</select></label>
      <label><span className="sr-only">Owner verification</span><select aria-label="Owner verification" value={ownership} onChange={event => filter('owner',event.target.value)}><option value="all">All owners</option><option value="verified">Verified</option><option value="official">Official</option><option value="unverified">Unverified</option></select></label>
    </div></div>
    {tab === 'watchlist' && <WatchlistSettings/>}
    {storageError && tab !== 'watchlist' && <p className="subtle-notice" role="status">{storageError}</p>}
    <div className="discovery-caption"><span>{tab === 'new' ? 'Latest launches' : tab === 'shipping' ? 'Ranked by code shipped this week: commits, merged pull requests and releases' : tab === 'watchlist' ? 'Repositories you’re watching' : `Ranked by 24h volume · new repos below ${PROMOTION_MIN_PERCENT}% of their graduation target come last`}</span>{(category !== 'all' || ownership !== 'all' || query) && <button type="button" onClick={() => { setQuery(''); router.replace(`/explore${tab !== 'trending' ? `?view=${tab}` : ''}`, { scroll: false }) }}>Clear filters</button>}</div>
    <MarketTable markets={tab === 'watchlist' && !ready ? [] : shown} usdPerSol={usdPerSol} empty={!ready && tab === 'watchlist' ? 'Loading your watchlist…' : empty}/>
    <div className="table-count">Showing {shown.length} of {markets.length} indexed markets{ownership === 'verified' && ' · Verification records repository admin access, not token endorsement.'}{ownership === 'official' && ' · Official: the verified maintainer launched the market from their payout wallet. Not an endorsement of the token.'}</div>
  </>
}
