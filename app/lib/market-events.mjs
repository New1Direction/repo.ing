// Server events invalidate display data. The existing APIs remain the authority.
export function watchMarketEvents(mint, { page = document, target = window, EventSourceClass = EventSource } = {}) {
  let source = null, stopped = false
  function update() {
    if (page.visibilityState !== 'visible' || stopped) { source?.close(); source = null; return }
    if (source) return
    source = new EventSourceClass(`/api/market/${encodeURIComponent(mint)}/events`)
    source.addEventListener('market', event => {
      if (stopped || page.visibilityState !== 'visible') return
      try {
        const data = JSON.parse(event.data)
        if (data.mint === mint && ['trade','curve','resync'].includes(data.kind)) target.dispatchEvent(new CustomEvent('repoing:market-updated', { detail: data }))
      } catch { /* Polling continues if an event cannot be used. */ }
    })
    // Native EventSource reconnects (each reconnect resyncs); 60s polling still covers lost notifications.
  }
  update(); page.addEventListener('visibilitychange', update)
  return () => { stopped = true; source?.close(); page.removeEventListener('visibilitychange', update) }
}
