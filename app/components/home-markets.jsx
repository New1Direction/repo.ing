'use client'
import { useState } from 'react'
import { MarketTable } from './ui'
import { HOME_MARKET_TABS } from '../lib/market-order.mjs'

export function HomeMarkets({ tabs, usdPerSol }) {
  const [tab, setTab] = useState('Trending')
  return <><div className="explore-controls"><div className="segmented" role="tablist" aria-label="Homepage markets">
    {HOME_MARKET_TABS.map(name => <button key={name} role="tab" aria-selected={tab === name} className={tab === name ? 'selected' : ''} onClick={() => setTab(name)}>{name}</button>)}
  </div><span className="muted filter-note">{tab === 'Trending' ? 'Ranked by 24h volume' : 'Latest launches'}</span></div>
    <MarketTable markets={tabs[tab]} usdPerSol={usdPerSol} empty="No indexed markets yet. Paste a repository above to start one."/></>
}
