// Display refreshes pause offscreen and resume immediately when the tab returns.
// Transaction settlement polling deliberately does not use this helper.
export function visiblePolling(refresh, interval, page = document, clock = window) {
  let running = false, stopped = false
  const tick = async () => {
    if (stopped || page.visibilityState !== 'visible' || running) return
    running = true
    try { await refresh() } finally { running = false }
  }
  void tick()
  const timer = clock.setInterval(tick, interval)
  page.addEventListener('visibilitychange', tick)
  return () => { stopped = true; clock.clearInterval(timer); page.removeEventListener('visibilitychange', tick) }
}
