// Status polling for panels whose reads cost chain reads (builder allocation, discovery rewards): read now, then again after
// next(result, failed) ms (null stops), only while the page is visible, and at once when it becomes visible again. One read at
// a time. now() reads at once, e.g. right after a claim so its confirmation checks start without waiting for the next read;
// asked while a read is running, it reads again as soon as that read ends (whose result may predate the claim).
// Unlike visiblePolling (a fixed interval), the delay follows each result: fast while something confirms, slow otherwise.
export function pollStatus(read, next, { page = document, clock = globalThis } = {}) {
  let stopped = false, running = false, again = false, timer = null
  async function tick() {
    clock.clearTimeout(timer); timer = null
    if (stopped || running || page.visibilityState !== 'visible') return
    running = true
    let result, failed = false
    try { result = await read() } catch { failed = true } finally { running = false }
    if (stopped) return
    if (again) { again = false; return void tick() }
    const wait = next(result, failed)
    if (wait != null) timer = clock.setTimeout(tick, wait)
  }
  const onVisible = () => { if (page.visibilityState === 'visible') void tick() }
  page.addEventListener('visibilitychange', onVisible)
  void tick()
  return {
    now: () => { if (running) again = true; else void tick() },
    stop() { stopped = true; clock.clearTimeout(timer); page.removeEventListener('visibilitychange', onVisible) },
  }
}
