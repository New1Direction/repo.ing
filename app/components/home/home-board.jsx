'use client'
import { useEffect, useRef, useState } from 'react'

// The tab a key moves to from tab `index` of `count` (ArrowRight/ArrowLeft wrap, Home and End jump), or null. A key held
// with a modifier is left to the browser (Alt+Left is Back).
export function tabForKey({ key, altKey = false, ctrlKey = false, metaKey = false, shiftKey = false }, index, count) {
  if (altKey || ctrlKey || metaKey || shiftKey) return null
  const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: count - 1 }[key]
  return next === undefined ? null : (next + count) % count
}

// The home page's one market board: its lists (tabs: [{ id, label, note }], panels: { [id]: node }) as tabs. Every panel is
// rendered on the server, so crawlers and a page without JavaScript still get every list; the board shows one at a time.
// The tab follows the URL hash (/#graduating lands on the board with that tab open), and arrow keys, Home and End move
// between tabs.
export function HomeBoard({ title, tabs, panels, action = null, footer = null }) {
  const [active, setActive] = useState(tabs[0].id)
  const buttons = useRef({})
  useEffect(() => {
    const fromHash = () => { const id = window.location.hash.slice(1); if (tabs.some(tab => tab.id === id)) setActive(id) }
    fromHash()
    window.addEventListener('hashchange', fromHash)
    return () => window.removeEventListener('hashchange', fromHash)
  }, [tabs])
  function select(id, focus = false) {
    setActive(id)
    // The native History API, as Next.js documents it: the router stays in sync and nothing scrolls.
    try { window.history.replaceState(null, '', id === tabs[0].id ? `${location.pathname}${location.search}` : `#${id}`) } catch { /* The tab still changes. */ }
    if (focus) buttons.current[id]?.focus()
  }
  function onKeyDown(event) {
    const next = tabForKey(event, tabs.findIndex(tab => tab.id === active), tabs.length)
    if (next === null) return
    event.preventDefault()
    select(tabs[next].id, true)
  }
  return <section className="home-board" aria-labelledby="home-board-title">
    {tabs.map(tab => <span key={tab.id} id={tab.id} className="home-board-anchor" aria-hidden="true"/>)}
    <div className="home-board-head">
      <h2 id="home-board-title">{title}</h2>
      <div className="home-board-tabs" role="tablist" aria-label={title} onKeyDown={onKeyDown}>
        {tabs.map(tab => <button key={tab.id} ref={node => { buttons.current[tab.id] = node }} type="button" role="tab" id={`home-tab-${tab.id}`}
          aria-controls={`home-panel-${tab.id}`} aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1}
          onClick={() => select(tab.id)}>{tab.label}</button>)}
      </div>
      {action}
    </div>
    {tabs.map(tab => <div key={tab.id} className="home-board-panel" role="tabpanel" id={`home-panel-${tab.id}`} aria-labelledby={`home-tab-${tab.id}`}
      hidden={active !== tab.id}>
      {tab.note && <p className="home-board-note">{tab.note}</p>}
      {panels[tab.id]}
    </div>)}
    {footer}
  </section>
}
