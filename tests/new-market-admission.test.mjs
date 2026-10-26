import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Connection } from '@solana/web3.js'
import { createNewMarketAdmissionReview } from '../src/new-market-admission.mjs'

// Public finalized CCTOOLKIT creation and account bytes; no signer, RPC credential or network access.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/recovered-ordinary-launch.json', import.meta.url)))
const market = { githubRepoId: 1278009399n, mint: 'GxKu7xYvScZzCpJLRigToUDFt7RLm4UpZkA4guLqCHBg',
  pool: '37uhKHh9TdvyBnh1XDHebLgLQfkcYtDTP1t3CCLJgrfV', creatorWallet: '3dHCTpgdx15yXyVGh7DK1woQ1XisQpmFCxncURrq63Gs',
  launcherWallet: '3eCFwDiKetHe9pg1zNEkTohUECu2vtsZDRMZ3jeR4g5o', launchSignature: fixture.signature,
  status: 'confirmed', indexedAt: new Date('2026-10-24T10:30:00Z'), launchFinality: 'finalized', launchSlot: 460857170n }
function connection(host, change = () => {}) {
  const input = structuredClone(fixture); change(input)
  return new Connection('https://' + host + '.invalid', { commitment: 'finalized', fetch: async (_url, options) => {
    const request = JSON.parse(options.body)
    assert.equal(request.params[1].commitment, 'finalized')
    let result
    if (request.method === 'getTransaction') result = input.transaction
    else if (request.method === 'getAccountInfo') result = { context: input.accounts.context, value: input.accounts.value[input.addresses.indexOf(request.params[0])] ?? null }
    else throw Error('Unexpected RPC method: ' + request.method)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'content-type': 'application/json' } })
  } })
}
const review = change => createNewMarketAdmissionReview({ connections: [connection('primary'), connection('independent', change)] })

test('safe finalized mint/config/pool/vault proof is reviewable without authorizing trading or a beneficiary', async () => {
  const result = await review()(market)
  assert.equal(result.state, 'eligible-for-review')
  assert.equal(result.tradingEnabled, false)
  assert.equal(result.repoId, '1278009399')
  assert.equal(result.launchSlot, '460857170')
  // CCTOOLKIT launched on Fy2bh before 3ZESQ became current: it keeps, and is checked on, the config it launched on.
  assert.equal(result.config, 'Fy2bhQbNPxLPShPxEuTnYzusWgSpSVEgCZ9cbby32TU7')
  for (const patch of [{ githubRepoId: 123n }, { creatorWallet: market.launcherWallet }, { pool: market.mint },
    { mint: market.launcherWallet }, { bundleId: '1' }, { transferHookProgram: market.mint }, { quoteMint: market.mint },
    { earlyAccessEnd: new Date() }, { status: 'pending' }, { indexedAt: null }, { launchFinality: 'confirmed' }, { launchSlot: 460857171n }]) {
    assert.equal((await review()({ ...market, ...patch })).state, 'denied')
  }
})

test('missing handoff, metadata, exact config bytes or independent finalized evidence cannot be replaced by a vault-owned pool', async () => {
  for (const change of [
    f => { f.transaction = null },
    f => { f.transaction.meta = null },
    f => { f.transaction.meta.err = { InstructionError: [1, 'InvalidArgument'] } },
    f => { f.transaction.transaction.message.instructions.pop() },
    f => { f.transaction.slot++ },
    f => { const data = Buffer.from(f.accounts.value[0].data[0], 'base64'); data[100] ^= 1; f.accounts.value[0].data[0] = data.toString('base64') },
    f => { f.accounts.value[0].owner = market.creatorWallet },
    f => { f.accounts.value[1] = null },
  ]) assert.equal((await review(change)(market)).state, 'denied')
  assert.throws(() => createNewMarketAdmissionReview({ connections: [connection('same'), connection('same')] }), /independent/i)
})
