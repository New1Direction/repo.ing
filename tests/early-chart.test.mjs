import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { earlyChartScript, takeEarlyChart } from '../app/lib/early-chart.mjs'

const MINT = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'

function runScript(source, { frames = 2 } = {}) {
  const requested = [], frameQueue = []
  const window = {}
  const context = vm.createContext({
    window,
    requestAnimationFrame: callback => frameQueue.push(callback),
    fetch: url => { requested.push(url); return Promise.resolve({ ok: true, json: async () => ({ url }) }) },
  })
  vm.runInContext(source, context)
  for (let i = 0; i < frames && frameQueue.length; i++) frameQueue.splice(0).forEach(callback => callback())
  return { window, requested }
}

test('early chart script requests trades and metrics only after two animation frames', () => {
  const source = earlyChartScript(MINT)
  assert.deepEqual(runScript(source, { frames: 1 }).requested, [])
  assert.deepEqual(runScript(source).requested, [`/api/market/${MINT}/trades?range=all`, `/api/market/${MINT}/metrics`])
})

test('PriceChart takes each early response once, and a taken slot is never requested late', async () => {
  const { window } = runScript(earlyChartScript(MINT))
  assert.deepEqual(await takeEarlyChart(MINT, 'trades', window), { url: `/api/market/${MINT}/trades?range=all` })
  assert.equal(takeEarlyChart(MINT, 'trades', window), null)
  assert.equal(takeEarlyChart(MINT, 'unknown', window), null)

  // Hydration finished before the frames fired: the script must not start a duplicate request.
  const late = { __repoingEarlyChart: {} }
  assert.equal(takeEarlyChart(MINT, 'metrics', late), null)
  const frames = []
  const context = vm.createContext({ window: late, requestAnimationFrame: callback => frames.push(callback), fetch: () => assert.fail('duplicate request') })
  takeEarlyChart(MINT, 'trades', late)
  vm.runInContext(earlyChartScript(MINT), context)
  frames.splice(0).forEach(callback => callback()); frames.splice(0).forEach(callback => callback())
})

test('early chart script escapes markup and works without a window', () => {
  assert.doesNotMatch(earlyChartScript('</script><b>'), /<\/script>/)
  assert.equal(takeEarlyChart(MINT, 'trades', undefined), null)
})
