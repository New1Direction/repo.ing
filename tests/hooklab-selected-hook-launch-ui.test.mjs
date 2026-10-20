import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'

// Real creator component/effects; synthetic wallet context and HTTP transport only.
const compiled = await build({
  entryPoints: [new URL('../app/components/hooklab-open-launch.jsx', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', packages: 'external',
  loader: { '.css': 'empty' },
  plugins: [{ name: 'selected-hook-wallet', setup(builder) {
    builder.onResolve({ filter: /^\.\/wallet$/ }, () => ({ path: 'wallet', namespace: 'test-context' }))
    builder.onResolve({ filter: /^\.\/hooklab-wallet-signin$/ }, () => ({ path: 'session', namespace: 'test-context' }))
    builder.onLoad({ filter: /.*/, namespace: 'test-context' }, ({ path }) => ({ contents: path === 'wallet'
      ? `export const useWallet = () => ({wallet:'So11111111111111111111111111111111111111112',provider(){throw Error('Signing provider must not be accessed')}})`
      : `export const useHookWalletSession = () => ({signedIn:true,checked:true,busy:false}); export const shortAddress = x => x; export const HookWalletSignIn = () => null` }))
    builder.onResolve({ filter: /^[^./]/ }, args => ({ path: import.meta.resolve(args.path.startsWith('next/') ? `${args.path}.js` : args.path), external: true }))
  } }],
})
const { HookOpenLaunch } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const selectedHook = { program: 'So11111111111111111111111111111111111111112', flags: 129 }
const coin = { name: 'Selected coin', symbol: 'SELECT', image: 'data:image/png;base64,AAAA', description: '', x: '', website: '', telegram: '', creatorFeeBps: 100, capBps: 0, hookKind: 'selected', selectedHook }
const availability = { status: 'available', openCreation: { native: true, open: true, paused: false, creatorFeeBps: [50, 100, 200], capBps: [100, 200], launchFeeLamports: '20000000' } }

test('creator records exact custom intent, recovers it on remount, and never signs even after successful reserve', async () => {
  await harness(async ui => {
    await ui.mount()
    await ui.click()
    const created = ui.calls.find(x => x.action === 'create')
    assert.deepEqual(created.selectedHook, selectedHook)
    assert.equal(created.capBps, 0)
    assert.deepEqual(ui.calls.filter(x => x.action === 'reserve').map(x => x.selectedHook), [selectedHook])
    assert.match(document.querySelector('[role="alert"]').textContent, /not available|unavailable/i)
    await ui.unmount(); await ui.mount({ coin: {} })
    assert.match(document.body.textContent, /Selected coin/)
    assert.match(document.body.textContent, /Flags: 129/)
    await ui.click()
    assert.equal(ui.calls.filter(x => x.action === 'create').length, 1)
    assert.equal(ui.calls.filter(x => x.action === 'reserve').length, 2)
    assert.ok(ui.calls.every(x => ['get', 'create', 'reserve'].includes(x.action)), 'no signing action is requested')
    assert.equal(document.querySelector('.hooks-open-signing'), null)
  })
})

for (const mutation of ['removed', 'changed']) test(`creator refuses ${mutation} hook in the create response before reserve`, async () => {
  await harness(async ui => {
    await ui.mount(); await ui.click()
    assert.deepEqual(ui.calls.map(x => x.action), ['get', 'create'])
    assert.match(document.querySelector('[role="alert"]').textContent, /configuration differs/)
    assert.equal(document.querySelector('.hooks-open-signing'), null)
  }, mutation)
})

async function harness(run, mutation) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://selected-ui.invalid' })
  const names = ['window', 'document', 'navigator', 'localStorage', 'fetch', 'IS_REACT_ACT_ENVIRONMENT']
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  for (const name of names.slice(0, 4)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const calls = [], errors = []; let retained = null, root
  globalThis.fetch = async (url, init) => {
    if (!init?.body) return Response.json(availability)
    const body = JSON.parse(init.body); calls.push(body)
    if (body.action === 'get') return Response.json({ status: 'available', request: retained })
    if (body.action === 'create') {
      retained = { ...body, id: body.requestId, status: 'queued', custodyOperationId: null, uri: 'https://selected-ui.invalid/metadata' }
      if (mutation === 'removed') { delete retained.selectedHook; retained.capBps = 100 }
      if (mutation === 'changed') retained.selectedHook = { ...selectedHook, flags: 1 }
      return Response.json({ status: 'available', request: retained })
    }
    if (body.action === 'reserve') return Response.json({ status: 'available', operationId: body.operationId, mint: selectedHook.program })
    throw Error(`Unexpected signing action: ${url} ${body.action}`)
  }
  const { createRoot } = await import('react-dom/client')
  const unmount = async () => { if (root) { await act(async () => root.unmount()); root = null } }
  try {
    await run({ calls, unmount,
      async mount(initial = {}) {
        root = createRoot(document.getElementById('root'), { onUncaughtError: e => errors.push(e.message) })
        await act(async () => root.render(createElement(HookOpenLaunch, { genesisHash: 'offline', initial: { availability, coin, step: 'review', ...initial } })))
      },
      async click() {
        const button = [...document.querySelectorAll('button')].find(b => b.textContent === 'Check hook availability')
        assert.ok(button); await act(async () => button.click()); assert.deepEqual(errors, [])
        assert.ok(calls.some(x => x.action === 'create') || retained, document.querySelector('[role="alert"]')?.textContent)
      },
    })
  } finally {
    await unmount(); dom.window.close()
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
}
