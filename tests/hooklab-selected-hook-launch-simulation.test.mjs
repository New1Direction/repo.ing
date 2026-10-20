import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { createHash } from 'node:crypto'
import { selectedLaunchCollectorFixture } from './fixtures/selected-hook-launch.mjs'
import { collectOpenLaunchReview } from '../src/hooklab-max-wallet-launch-collector.mjs'
import { deriveOpenLaunchPostconditions } from '../src/hooklab-max-wallet-launch-settlement.mjs'
import { collectSelectedHookLaunchSimulation as collect } from '../src/hooklab-selected-hook-launch-simulation.mjs'

async function fixture(options) {
  const f = selectedLaunchCollectorFixture(options), collected = await collectOpenLaunchReview(f)
  const { plan, settlementContext, configurationSha256 } = collected
  const postconditions = deriveOpenLaunchPostconditions(settlementContext, { slot: 100, timestamp: 0 })
  const post = new Map(structuredClone([...f.accounts]))
  for (const a of postconditions.accounts) post.set(a.address, { ...a, lamports: f.accounts.get(a.address)?.lamports ?? '100' })
  post.set(plan.review.payer, { ...post.get(plan.review.payer),
    lamports: String(BigInt(post.get(plan.review.payer).lamports) - BigInt(plan.review.maxNativeDebitLamports)) })
  const simulated = []
  for (const { connection } of f.connections) connection.simulateTransaction = async (tx, options) => {
    assert.ok(options.accounts.addresses.length <= plan.review.accounts.length, 'RPC account return limit follows message account count')
    const wire = Buffer.from(tx.message.serialize()).toString('base64')
    simulated.push(wire)
    assert.equal(wire, plan.review.messageBase64)
    assert.equal(options.sigVerify, false); assert.equal(options.replaceRecentBlockhash, false)
    return { context: { slot: 100 }, value: { err: null, unitsConsumed: 100000,
      accounts: options.accounts.addresses.map(address => {
        const a = post.get(address)
        return a ? { owner: a.owner, executable: a.executable, lamports: Number(a.lamports), data: [a.dataBase64, 'base64'] }
          : { owner: '11111111111111111111111111111111', executable: false, lamports: 0, data: ['', 'base64'] }
      }) } }
  }
  return { ...f, plan, settlementContext, configurationSha256, post, simulated }
}

test('selected launch simulates retained wire, canonical holdings and mutable counters; revalidation preserves evidence', async () => {
  const f = await fixture(), result = await collect(f)
  assert.equal(result.messageSha256, f.plan.review.messageSha256)
  assert.equal(Object.keys(result.tokenDeltas).length, 5)
  for (const role of ['launchReserve', 'launchQuote', 'baseVault', 'quoteVault', 'launchLp']) {
    const a = f.post.get(f.addresses[role])
    assert.equal(result.tokenDeltas[a.address], String(Buffer.from(a.dataBase64, 'base64').readBigUInt64LE(74)))
  }
  assert.equal(result.lamportDeltas[f.plan.review.payer], `-${f.plan.review.maxNativeDebitLamports}`)
  assert.deepEqual(await collect({ ...f, expected: JSON.parse(JSON.stringify(result)) }), result)
  assert.ok(f.simulated.length >= 4)
  assert.ok(f.simulated.every(wire => wire === f.plan.review.messageBase64))
  assert.equal(result.canSign, false); assert.equal(result.canSubmit, false)
})

test('selected launch revalidates retained consent with fresh observation metadata', async () => {
  const f = await fixture(), expected = await collect(f)
  const refreshed = await collectOpenLaunchReview({ ...f, expectedReview: f.plan.review, clock: () => 1001 })
  assert.deepEqual(refreshed.plan.review, f.plan.review)
  assert.deepEqual(await collect({ ...f, ...refreshed, expected, clock: () => 1001 }), expected)
})

test('selected launch rejects changed wire/configuration and retained evidence', async () => {
  const f = await fixture(), expected = await collect(f)
  await assert.rejects(collect({ ...f, configurationSha256: 'f'.repeat(64), expected }))
  await assert.rejects(collect({ ...f, configurationSha256: 'f'.repeat(64),
    settlementContext: { ...f.settlementContext, configurationSha256: 'f'.repeat(64) }, expected }))
  await assert.rejects(collect({ ...f, plan: { ...f.plan, review: { ...f.plan.review, messageSha256: 'f'.repeat(64) } }, expected }))
  await assert.rejects(collect({ ...f, expected: { ...expected, conditionsSha256: 'f'.repeat(64) } }))
})

test('selected launch rejects holding identity/tails/minimums and payer or other writable negative native deltas', async () => {
  for (const mutate of [
    f => { const a = f.post.get(f.addresses.baseVault), b = Buffer.from(a.dataBase64, 'base64'); b.writeBigUInt64LE(b.readBigUInt64LE(74) - 1n, 74); a.dataBase64 = b.toString('base64') },
    f => { const a = f.post.get(f.addresses.launchQuote), b = Buffer.from(a.dataBase64, 'base64'); new PublicKey(f.request.creator).toBuffer().copy(b, 42); a.dataBase64 = b.toString('base64') },
    f => { const a = f.post.get(f.addresses.launchLp), b = Buffer.from(a.dataBase64, 'base64'); b[82] = 1; a.dataBase64 = b.toString('base64') },
    f => { const a = f.post.get(f.plan.review.payer); a.lamports = String(BigInt(a.lamports) - 1n) },
    f => { const a = f.post.get(f.addresses.launchConfig); a.lamports = String(BigInt(a.lamports) - 1n) },
  ]) { const f = await fixture(); mutate(f); await assert.rejects(collect(f), { code: 'SELECTED_HOOK_SIMULATION_UNAVAILABLE' }) }
})

test('selected launch pins readonly program/config/registry/lookup bytes and rejects duplicate observations', async () => {
  for (const role of ['selectedProgramData', 'registry', 'launchGovernance']) {
    const f = await fixture(); f.post.get(f.addresses[role]).dataBase64 = ''
    await assert.rejects(collect(f))
  }
  const f = await fixture(); f.post.get(f.request.selectedConfig).dataBase64 = ''; await assert.rejects(collect(f))
  const table = await fixture(); table.post.get(table.plan.review.lookupTables[0].address).dataBase64 = ''; await assert.rejects(collect(table))
  const duplicate = await fixture(); duplicate.settlementContext.compilationInput.observations[0].accounts.push(duplicate.settlementContext.compilationInput.observations[0].accounts[0])
  await assert.rejects(collect(duplicate))
  const aliased = await fixture(); aliased.connections[1].connection = aliased.connections[0].connection
  await assert.rejects(collect(aliased))
  const program = await fixture(); program.post.get(program.input.hookPin.program).dataBase64 = ''; await assert.rejects(collect(program))
  const absent = await fixture(); absent.post.set(absent.addresses.selectedTokenSigner, { owner: absent.p.programs.token,
    executable: false, lamports: '1', dataBase64: '' }); await assert.rejects(collect(absent))
})

test('selected launch recollects a transient bank advance but refuses execution changes between return slices', async () => {
  for (const kind of ['bank', 'execution']) {
    const f = await fixture(), connection = f.connections[0].connection, simulate = connection.simulateTransaction
    let calls = 0
    connection.simulateTransaction = async (...args) => {
      const result = await simulate(...args)
      if (++calls === 2) {
        if (kind === 'bank') result.context.slot++
        else result.value.unitsConsumed++
      }
      return result
    }
    if (kind === 'bank') assert.equal((await collect(f)).messageSha256, f.plan.review.messageSha256)
    else await assert.rejects(collect(f), { code: 'SELECTED_HOOK_SIMULATION_UNAVAILABLE' })
  }
})

test('selected launch binds writable hook bytes across consent, revalidation and settlement', async () => {
  const f = await fixture({ hookState: true })
  const address = f.plan.selectedHookExtras[0].address, a = f.post.get(address)
  a.dataBase64 = Buffer.from([1]).toString('base64')
  const expected = await collect(f)
  const digest = createHash('sha256').update(JSON.stringify({ address, owner: a.owner,
    executable: false, dataBase64: 'AQ==' })).digest('hex')
  assert.deepEqual(expected.hookPostStateHashes, { [address]: digest })
  assert.deepEqual(await collect({ ...f, expected }), expected)
  a.dataBase64 = Buffer.from([2]).toString('base64')
  await assert.rejects(collect({ ...f, expected }), { code: 'SELECTED_HOOK_SIMULATION_UNAVAILABLE' })
})
