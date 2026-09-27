'use client'
import Link from 'next/link'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Bell, Eye, Check, X } from 'lucide-react'
import { WATCHLIST_KEY, emptyWatchlist, parseWatchlist, toggleWatched, applyPriceUpdates } from '../lib/watchlist.mjs'
import { MenuDetails } from './menu-details'

const WatchlistContext = createContext(null)
export function WatchlistProvider({ children }) {
  const [state, setState] = useState(emptyWatchlist)
  const current = useRef(state)
  const [ready, setReady] = useState(false)
  const [storageError, setStorageError] = useState('')
  const [priceError, setPriceError] = useState('')
  const update = useCallback(change => {
    const next = change(current.current)
    current.current = next; setState(next)
    try { localStorage.setItem(WATCHLIST_KEY, JSON.stringify(next)); setStorageError('') }
    catch { setStorageError('Browser storage is unavailable. Your watchlist will last for this visit only.') }
  }, [])
  useEffect(() => {
    const restore = () => {
      try { const next = parseWatchlist(localStorage.getItem(WATCHLIST_KEY)); current.current = next; setState(next) }
      catch { setStorageError('Browser storage is unavailable. Your watchlist will last for this visit only.') }
    }
    restore(); setReady(true)
    const sync = event => { if (event.key === WATCHLIST_KEY || event.key === null) restore() }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
  const ids = state.items.map(item => item.repoId).sort().join(',')
  useEffect(() => {
    if (!ready || !ids || !state.alertPercent) { setPriceError(''); return }
    let stopped = false, busy = false, lastCheck = 0
    const controller = new AbortController()
    async function check() {
      if (stopped || busy || document.visibilityState !== 'visible' || Date.now() - lastCheck < 30000) return
      busy = true; lastCheck = Date.now()
      try {
        const response = await fetch(`/api/watchlist?repos=${encodeURIComponent(ids)}`, { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
        const data = await response.json()
        if (!response.ok || !Array.isArray(data.quotes)) throw Error('Unavailable')
        if (!stopped) { update(value => applyPriceUpdates(value, data.quotes)); setPriceError('') }
      } catch { if (!stopped) setPriceError('Price alerts could not refresh. We’ll retry automatically.') }
      finally { busy = false }
    }
    check()
    const interval = setInterval(check, 60000)
    document.addEventListener('visibilitychange', check)
    return () => { stopped = true; controller.abort(); clearInterval(interval); document.removeEventListener('visibilitychange', check) }
  }, [ready, ids, state.alertPercent, update])
  return <WatchlistContext.Provider value={{ state, ready, update, storageError, priceError }}>{children}</WatchlistContext.Provider>
}
export function useWatchlist() { return useContext(WatchlistContext) }

export function WatchButton({ market, compact = false }) {
  const { state, ready, update } = useWatchlist()
  const [error, setError] = useState('')
  const watched = state.items.some(item => item.repoId === String(market.repoId))
  function toggle() {
    try { update(value => toggleWatched(value, market)); setError('') }
    catch (error) { setError(error.message) }
  }
  const label = `${watched ? 'Unwatch' : 'Watch'} ${market.fullName}`
  return <span className="watch-control"><button type="button" className={`button outline watch-button ${compact ? 'compact' : ''}`} disabled={!ready}
    aria-label={label} title={label} aria-pressed={watched} onClick={toggle}>
    {watched ? <Check size={15}/> : <Eye size={15}/>} {!compact && (watched ? 'Watching' : 'Watch')}
  </button>{error && <small className="watch-error" role="alert">{error}</small>}</span>
}

export function WatchlistSettings() {
  const { state, ready, update, storageError, priceError } = useWatchlist()
  return <div className="watchlist-settings"><div><strong>Your watchlist</strong><p>Saved in this browser. No wallet needed.</p></div>
    <label>Price alerts <select aria-label="Watchlist price alerts" disabled={!ready} value={state.alertPercent}
      onChange={event => update(value => ({ ...value, alertPercent: Number(event.target.value), baselines: {} }))}>
      <option value="0">Off</option><option value="10">10% moves</option><option value="25">25% moves</option>
    </select></label>
    <p className="watchlist-note">{state.alertPercent ? 'Alerts appear in the bell menu while repo.ing is open. Based on indexed SOL prices before graduation; not an execution quote.' : 'Turn on optional price alerts for the repositories you watch.'}</p>
    {(storageError || priceError) && <p className="watchlist-note" role="status">{storageError || priceError}</p>}
  </div>
}
export function WatchNotifications() {
  const { state, ready, update, priceError } = useWatchlist()
  const unread = state.notifications.filter(n => !n.read).length
  if (!ready || (!state.alertPercent && !state.notifications.length)) return null
  const markRead = id => update(value => ({ ...value, notifications: value.notifications.map(n => !id || n.id === id ? { ...n, read: true } : n) }))
  return <MenuDetails className="watch-notifications" summary={<><Bell size={19}/>{unread > 0 && <i className="notification-dot"/>}</>} label={`Watchlist notifications${unread ? `, ${unread} unread` : ''}`}>
    <div className="menu-panel notification-panel"><div className="menu-heading"><strong>Watchlist updates</strong>{unread > 0 && <button type="button" onClick={() => markRead()}>Mark all read</button>}</div>
      {state.notifications.length ? <ul>{state.notifications.map(n => {
        const item = state.items.find(item => item.repoId === n.repoId)
        return item && <li key={n.id} className={n.read ? '' : 'unread'}><Link href={`/token/${item.mint}`} onClick={event => { markRead(n.id); event.currentTarget.closest("details").open = false }}><strong>{item.fullName}</strong><span>{n.text}</span><small>{new Date(n.at).toLocaleString()}</small></Link><button type="button" aria-label={`Dismiss update for ${item.fullName}`} onClick={() => update(value => ({ ...value, notifications: value.notifications.filter(item => item.id !== n.id) }))}><X size={14}/></button></li>
      })}</ul> : <p className="menu-empty">You’re all caught up. New price alerts will appear here.</p>}
      {priceError && <p className="menu-empty" role="status">{priceError}</p>}
      <Link className="menu-footer" href="/explore?view=watchlist" onClick={event => { event.currentTarget.closest("details").open = false }}>View watchlist & settings</Link>
    </div>
  </MenuDetails>
}
