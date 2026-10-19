import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'

// Render the real client component and React effects. Only the wallet context and
// HTTP boundary are synthetic; no validator, custody, signing or network is used.
const require = createRequire(import.meta.url)
const walletSlot = Symbol.for('hooklab.local-operations.regression.wallet')
const compiled = await build({
  entryPoints: [new URL('../app/components/hooklab-local-operations.jsx', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
  plugins: [{ name: 'isolated-wallet-context', setup(builder) {
    builder.onResolve({ filter: /^\.\/wallet$/ }, () => ({ path: 'wallet-context', namespace: 'test-wallet' }))
    builder.onLoad({ filter: /.*/, namespace: 'test-wallet' }, () => ({ contents: `export const useWallet = () => globalThis[Symbol.for('hooklab.local-operations.regression.wallet')]` }))
    builder.onResolve({ filter: /^(react(?:\/.*)?|@solana\/web3\.js)$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
  } }],
})
const { HookLocalOperations } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const seed = label => createHash('sha256').update(`SYNTHETIC UI REGRESSION ONLY ${label}`).digest()
const owner = Keypair.fromSeed(seed('owner')).publicKey
const other = Keypair.fromSeed(seed('other')).publicKey
const signingId = '00000000-0000-4000-8000-000000000001'
const genesisHash = 'isolated-ui-regression-no-rpc'
const storageKey = 'repo.ing.hooks.local-operation.v1'

async function harness(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://hooklab-regression.invalid' })
  const names = ['window', 'document', 'navigator', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  for (const name of names.slice(0, 4)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // WebCrypto's digest settles on the libuv threadpool, so on a busy CI runner the signing handoff could still be
  // waiting on it after settle() (a flaky "signCalls: 0"). The card's state transitions are what this tests, so the
  // same SHA-256 settles as an ordinary promise here; it is removed again below.
  const subtle = globalThis.crypto.subtle
  Object.defineProperty(subtle, 'digest', { configurable: true, value: async (algorithm, data) => {
    assert.equal(algorithm, 'SHA-256'); const digest = createHash('sha256').update(Buffer.from(data)).digest()
    return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength) } })
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: owner, recentBlockhash: Keypair.fromSeed(seed('blockhash')).publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: owner, toPubkey: other, lamports: 1 })],
  }).compileToV0Message())
  const message = Buffer.from(tx.message.serialize())
  const review = { wallet: owner.toBase58(), genesisHash, messageSha256: createHash('sha256').update(message).digest('hex'),
    messageBase64: message.toString('base64'), reviewExpiresAtMs: Date.now() + 60000,
    baseFeeLamports: '5000', maxNativeDebitLamports: '5001', accounts: [], requiredSigners: [owner.toBase58()] }
  const operation = { id: signingId, owner: owner.toBase58(), status: 'reviewed', review, messageSha256: review.messageSha256 }
  let release, requestStarted, signCalls = 0, retainCalls = 0
  const started = new Promise(resolve => { requestStarted = resolve })
  const response = new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ status: 'available', review, partialTransactionBase64: Buffer.from(tx.serialize()).toString('base64') }) }) })
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/hook-lab/local-operations')
    const body = JSON.parse(options.body)
    assert.equal(body.signingId, signingId)
    if (body.action === 'review') return { ok: true, json: async () => ({ status: 'available', operation }) }
    if (body.action === 'wallet-request') { requestStarted(); return response }
    if (body.action === 'retain-wallet') { retainCalls++; return { ok: true, json: async () => ({ status: 'available', operation: { ...operation, status: 'partial', walletRequestIssued: true } }) } }
    throw Error(`Unexpected UI regression request: ${body.action}`)
  }
  const provider = () => ({ async signTransaction(value) { signCalls++; return value } })
  globalThis[walletSlot] = { wallet: owner.toBase58(), provider }
  localStorage.setItem(storageKey, JSON.stringify({ id: signingId, mint: other.toBase58(), kind: 'prepare-trading' }))
  const errors = []
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root'), { onUncaughtError: error => errors.push(error.message) })
  const button = text => [...document.querySelectorAll('button')].find(node => node.textContent === text)
  try {
    await act(async () => root.render(createElement(HookLocalOperations, { genesisHash })))
    await act(async () => button('Resume retained local review').click())
    await act(async () => document.querySelector('input[type="checkbox"]').click())
    await act(async () => { button('Sign reviewed local transaction').click(); await started })
    await run({ root, errors, button, release, provider,
      calls: () => ({ signCalls, retainCalls }),
      async wallet(value) {
        globalThis[walletSlot] = { wallet: value, provider }
        await act(async () => root.render(createElement(HookLocalOperations, { genesisHash })))
      },
      // Several event-loop turns, so a late response is fully processed before the "never signs" checks run.
      async settle() { await act(async () => { release(); for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve)) }) },
    })
  } finally {
    await act(async () => root.unmount())
    delete subtle.digest
    delete globalThis[walletSlot]
    dom.window.close()
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
}

for (const [transition, wallets] of [
  ['switching wallets', [other.toBase58()]],
  ['disconnecting', [null]],
  ['switching away and back', [other.toBase58(), owner.toBase58()]],
]) {
  test(`late wallet-request after ${transition} cannot revive the cleared operation or invoke signing`, async () => {
    await harness(async ui => {
      for (const wallet of wallets) await ui.wallet(wallet)
      await ui.settle()
      assert.deepEqual(ui.errors, [], 'the card must not crash by rendering a partial operation')
      assert.deepEqual(ui.calls(), { signCalls: 0, retainCalls: 0 })
      assert.equal(document.querySelector('h3'), null)
      assert.match(document.querySelector('[role="alert"]').textContent, /wallet|review/i)
      assert.match(document.querySelector('[role="status"]').textContent, /Refresh the retained local operation/)
      assert.match(document.body.textContent, new RegExp(signingId))
    })
  })
}

test('unchanged wallet retains the issued review and completes the local signing handoff', async () => {
  await harness(async ui => {
    await ui.settle()
    assert.deepEqual(ui.errors, [])
    assert.deepEqual(ui.calls(), { signCalls: 1, retainCalls: 1 })
    assert.equal(document.querySelector('h3').textContent, 'Local operation: partial')
    assert.equal(ui.button('Refresh unsigned local review').disabled, true)
    assert.equal(document.querySelector('[role="alert"]'), null)
  })
})
