'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowRight, ChevronRight, Image as ImageIcon, Search } from 'lucide-react'
import { marketCapDisplay } from '../lib/market-display.mjs'
import { formatSolDisplay } from '../lib/format.mjs'
import { hookCoinView, orderHookCoins } from '../lib/hooklab-explore-order.mjs'
import { HOOK_TYPES, feeHeadline, filterCoins } from '../lib/hooklab-ux.mjs'
import { HookTypeBadges } from './hooks-badges'
import '../hooks-explore.css'

export const EXPLORE_STRIP_COINS = 4
const HEADINGS = ['#', 'Coin', 'Market cap', '24h Volume', 'Trades']
const VIEWS = [['trending', 'Trending'], ['mcap', 'Market cap'], ['new', 'New']]
const CAPTIONS = { trending: 'Ranked by 24h volume', mcap: 'Ranked by market cap', new: 'Latest launches' }
const coinHref = mint => `/hooks/token/${mint}`

function CoinAvatar({ image }) {
  const [failed, setFailed] = useState(false)
  return <span className="repo-avatar hook-coin-avatar">{image && !failed ? <img src={image} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)}/> : <ImageIcon size={20} aria-hidden="true"/>}</span>
}
// Every Hooks coin mints 1,000,000,000 tokens; its cap is the last trade price × that supply (burns move it by a sliver).
const HOOK_COIN_SUPPLY = Object.freeze({ baseUnits: '1000000000', decimals: 0 })
// Under 0.01 SOL a 24h volume is dust: not shown.
const MIN_SHOWN_VOLUME_LAMPORTS = 10_000_000n
const tradedRecently = coin => /^\d+$/.test(String(coin.stats?.volume24hLamports ?? '')) && BigInt(coin.stats.volume24hLamports) >= MIN_SHOWN_VOLUME_LAMPORTS
const volume = coin => tradedRecently(coin) ? `${formatSolDisplay(coin.stats.volume24hLamports)} SOL` : '—'
function Cap({ coin, usdPerSol }) {
  const cap = marketCapDisplay(coin.stats?.priceSol, HOOK_COIN_SUPPLY, usdPerSol)
  return <span className="table-mcap" title={cap?.title ?? 'No trades yet'}>{cap?.value ?? '—'}</span>
}

function CoinRow({ coin, index, usdPerSol }) {
  return <div className="market-row"><span className="row-index">{index + 1}</span>
    <Link href={coinHref(coin.mint)} className="table-repo"><CoinAvatar image={coin.image}/><span><span className="table-repo-name"><strong>{coin.name}</strong><span className="table-repo-ticker">${coin.symbol}</span></span><small>{feeHeadline(coin).text}</small><HookTypeBadges coin={coin} className="is-row"/></span></Link>
    <Cap coin={coin} usdPerSol={usdPerSol}/><span className="table-volume">{volume(coin)}</span><span>{coin.stats?.totalTrades > 0 ? coin.stats.totalTrades.toLocaleString('en-US') : '—'}</span>
    <span className="table-actions"><Link href={coinHref(coin.mint)} className="button outline table-action">Trade<ChevronRight size={15}/></Link></span></div>
}

// Explore → Hooks coins and Hooks → Buy & sell: every listed coin, with the same views, search and table as the repository markets.
// basePath: the page the view tabs keep in the address (Explore's tab, or Hooks → Buy & sell).
export function HookCoinExplore({ coins, usdPerSol, basePath = '/explore/hooks' }) {
  const router = useRouter(), params = useSearchParams()
  const view = hookCoinView(params.get('view'))
  const type = HOOK_TYPES.some(([id]) => id === params.get('type')) ? params.get('type') : 'all'
  const [query, setQuery] = useState('')
  const shown = useMemo(() => orderHookCoins(filterCoins(coins, type).filter(c => `${c.name} ${c.symbol} ${c.mint}`.toLowerCase().includes(query.trim().toLowerCase())), view), [coins, query, view, type])
  // View and hook type live in the address (shareable), updated in place with no page reload.
  const go = (key, value, fallback) => { const next = new URLSearchParams(params.toString()); value === fallback ? next.delete(key) : next.set(key, value); router.replace(`${basePath}${next.size ? `?${next}` : ''}`, { scroll: false }) }
  const select = value => go('view', value, 'trending')
  return <>
    <div className="explore-search"><Search size={20}/><input aria-label="Search Hooks coins" placeholder="Search coins, tickers or addresses..." value={query} onChange={e => setQuery(e.target.value)}/></div>
    <div className="discovery-controls"><div className="discovery-tabs" aria-label="Hooks coin views">
      {VIEWS.map(([value, label]) => <button type="button" key={value} aria-pressed={view === value} onClick={() => select(value)}>{label}</button>)}
    </div></div>
    <div className="hook-chips" role="group" aria-label="Filter by hook">
      {[['all', 'All hooks'], ...HOOK_TYPES].map(([id, label]) => <button type="button" key={id} className={`hook-chip is-${id}`} aria-pressed={type === id}
        onClick={() => go('type', id, 'all')}>{label}<span>{id === 'all' ? coins.length : filterCoins(coins, id).length}</span></button>)}
    </div>
    <div className="discovery-caption"><span>{CAPTIONS[view]}</span>{(query || type !== 'all') && <button type="button" onClick={() => { setQuery(''); go('type', 'all', 'all') }}>Clear filters</button>}</div>
    <div className="market-table-scroll"><div className="market-table hook-coin-table"><div className="market-head">{HEADINGS.map(h => <span key={h}>{h}</span>)}<span className="actions-heading">Action</span></div>
      {shown.length ? shown.map((coin, index) => <CoinRow key={coin.mint} coin={coin} index={index} usdPerSol={usdPerSol}/>)
        : <div className="table-empty">{coins.length ? 'No coins match these filters.' : <>No Hooks coins yet. <Link href="/hooks">Launch the first one</Link>.</>}</div>}
    </div></div>
    <div className="table-count">Showing {shown.length} of {coins.length} Hooks coins</div>
  </>
}

// The strip on /explore: the busiest few coins that traded in the last 24 hours, linked to the full list. Nothing at all
// while no coin has (no row of "—" and "0 SOL 24h").
export function HookCoinStrip({ coins, usdPerSol }) {
  const top = orderHookCoins(coins.filter(tradedRecently)).slice(0, EXPLORE_STRIP_COINS)
  if (!top.length) return null
  return <section className="hooks-strip" aria-labelledby="hooks-strip-title">
    <div className="section-heading"><div><h2 id="hooks-strip-title">Hooks coins</h2><p>Coins with their own rules: max wallets, creator fees and burns.</p></div>
      <Link className="view-all" href="/explore/hooks">See all {coins.length} <ArrowRight size={16} aria-hidden="true"/></Link></div>
    <ul>{top.map(coin => <li key={coin.mint}><Link href={coinHref(coin.mint)} className="hooks-strip-card"><CoinAvatar image={coin.image}/>
      <span className="hooks-strip-copy"><strong>${coin.symbol}</strong><small>{coin.name}</small></span>
      <span className="hooks-strip-figures"><Cap coin={coin} usdPerSol={usdPerSol}/><small>{volume(coin)} 24h</small></span></Link></li>)}</ul>
  </section>
}
