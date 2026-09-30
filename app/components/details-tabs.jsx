'use client'
import { useEffect, useId, useRef, useState } from 'react'

// Accessible tabs (roles, arrow keys, Home/End). Panels stay mounted so server-rendered content and live cards keep
// their state; a URL hash naming a tab's anchor (e.g. #repository) selects it.
export function DetailsTabs({ tabs, initial, label = 'Details' }) {
  const [selected, setSelected] = useState(initial ?? tabs[0]?.id)
  const list = useRef(null)
  const id = useId()
  useEffect(() => {
    const fromHash = () => {
      const tab = tabs.find(t => t.anchor && `#${t.anchor}` === window.location.hash)
      if (!tab) return
      setSelected(tab.id)
      requestAnimationFrame(() => document.getElementById(tab.anchor)?.scrollIntoView({ block: 'start' }))
    }
    fromHash()
    window.addEventListener('hashchange', fromHash)
    return () => window.removeEventListener('hashchange', fromHash)
  }, [tabs])
  function onKeyDown(event) {
    const at = tabs.findIndex(t => t.id === selected)
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[event.key]
    if (next === undefined) return
    event.preventDefault()
    const tab = tabs[(next + tabs.length) % tabs.length]
    setSelected(tab.id)
    list.current?.querySelector(`[data-tab="${tab.id}"]`)?.focus()
  }
  return <>
    <div className="details-tabs" role="tablist" aria-label={label} ref={list} onKeyDown={onKeyDown}>
      {tabs.map(tab => <button key={tab.id} type="button" role="tab" data-tab={tab.id} id={`${id}-${tab.id}-tab`} aria-controls={`${id}-${tab.id}`}
        aria-selected={tab.id === selected} tabIndex={tab.id === selected ? 0 : -1} onClick={() => setSelected(tab.id)}>{tab.label}</button>)}
    </div>
    {tabs.map(tab => <div key={tab.id} role="tabpanel" id={`${id}-${tab.id}`} aria-labelledby={`${id}-${tab.id}-tab`} className="details-panel"
      hidden={tab.id !== selected} tabIndex={0}>{tab.content}</div>)}
  </>
}
