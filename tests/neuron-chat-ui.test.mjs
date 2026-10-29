import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { appModule, h } from './fixtures/render-jsx.mjs'

const { NeuronRecipeChat } = await appModule('app/components/neuron-recipe-chat.jsx')
const { WalletProvider } = await appModule('app/components/wallet.jsx')

test('mock chat requires identity, retries safely, escapes text, and clears private conversation on sign-out', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://chat.onamp.dev/neurons/fixture' })
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    self: dom.window, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const fetcher = globalThis.fetch, calls = []
  let root, signedIn = false, networkFailure = true, finish
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
    globalThis.fetch = async (url, options) => {
      if (url === '/api/hook-lab/wallet-identity') {
        if (options?.method === 'POST') { signedIn = false; return Response.json({ signedIn: false }) }
        return Response.json(signedIn ? { signedIn: true, wallet: '11111111111111111111111111111111', expiresAt: new Date(Date.now() + 60000).toISOString() } : { signedIn: false })
      }
      assert.equal(url, '/api/neuron-chat'); calls.push(JSON.parse(options.body))
      if (networkFailure) { networkFailure = false; throw Error('Connection interrupted') }
      if (calls.length === 3) return new Promise(resolve => { finish = () => resolve(Response.json({ reply: 'Private late reply', mode: 'mock', liveInference: false })) })
      return Response.json({ reply: '<script>Test reply</script>', mode: 'mock', liveInference: false })
    }
    const { createRoot } = await import('react-dom/client')
    root = createRoot(document.getElementById('root'))
    const render = async key => act(async () => root.render(h(WalletProvider, null, h(NeuronRecipeChat, { key, characterId: 'fixture', name: 'Ocean', genesisHash: 'fixture' }))))
    await render('anonymous')
    assert.equal(document.querySelector('textarea').disabled, true)
    signedIn = true; await render('signed-in')
    assert.equal(document.querySelector('textarea').disabled, false)
    const fill = async value => act(async () => {
      const input = document.querySelector('textarea')
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(input, value)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    const submit = async () => act(async () => document.querySelector('form').requestSubmit())
    await fill('Hello ocean'); await submit()
    assert.match(document.querySelector('[role="alert"]').textContent, /Connection interrupted/)
    await submit()
    assert.deepEqual(calls[0], calls[1])
    assert.deepEqual(Object.keys(calls[1]).sort(), ['characterId', 'conversationId', 'message', 'requestId'])
    assert.match(document.querySelector('[role="log"]').textContent, /<script>Test reply<\/script>/)
    assert.equal(document.querySelector('script'), null)
    assert.equal(document.querySelector('textarea').value, '')
    await fill('Second question'); await submit()
    assert.equal(document.querySelector('textarea').disabled, true)
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Sign out').click())
    await act(async () => finish())
    assert.doesNotMatch(document.querySelector('[role="log"]').textContent, /Test reply|Private late reply|Hello ocean/)
    assert.equal(document.querySelector('textarea').disabled, true)
  } finally {
    if (root) await act(async () => root.unmount())
    globalThis.fetch = fetcher
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    dom.window.close()
  }
})
