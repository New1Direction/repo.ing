import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, SendTransactionError, TransactionExpiredBlockheightExceededError } from '@solana/web3.js'
import { createMeteoraLauncher, DefinitiveLaunchError } from '../src/meteora-launch.mjs'
import { IncompleteLaunchError } from '../src/launch-coordinator.mjs'
import { launchFailure } from '../src/launch-failure.mjs'
import { LAUNCH_REVIEW_EXPIRED } from '../src/launch-expiry.mjs'

// A launch signed after its blockhash expired, or refused by the RPC, never reached Solana: it is a definitive failure the
// launcher can refresh and retry. Only an unknown outcome stays ambiguous (src/meteora-launch.mjs submit).
const launch = { raw: Buffer.from([1]), signature: '1'.repeat(64), blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000n }
function launcherWith({ height = 900, send = async () => 'sig', confirm = async () => ({ value: { err: null } }) } = {}) {
  const calls = { send: 0, confirm: 0 }
  const connection = {
    rpcEndpoint: 'http://fake',
    getBlockHeight: async () => { if (height instanceof Error) throw height; return height },
    sendRawTransaction: async (...args) => { calls.send++; return send(...args) },
    confirmTransaction: async (...args) => { calls.confirm++; return confirm(...args) },
  }
  return { launcher: createMeteoraLauncher({ connection, config: Keypair.generate().publicKey.toBase58(), creator: Keypair.generate() }), calls }
}
const refused = transactionMessage => new SendTransactionError({ action: 'simulate', signature: '', transactionMessage, logs: [] })

test('a review signed after its blockhash expired is never sent and can be refreshed', async () => {
  const { launcher, calls } = launcherWith({ height: 1001 })
  await assert.rejects(() => launcher.submit(launch), error => error instanceof DefinitiveLaunchError && error.message === LAUNCH_REVIEW_EXPIRED)
  assert.equal(calls.send, 0)
})

test('a block height that cannot be read sends nothing and can be refreshed', async () => {
  const { launcher, calls } = launcherWith({ height: Error('fetch failed') })
  await assert.rejects(() => launcher.submit(launch), DefinitiveLaunchError)
  assert.equal(calls.send, 0)
})

test('an RPC refusal is definitive; an expired blockhash says so', async () => {
  for (const [message, expected] of [
    ['Transaction simulation failed: Blockhash not found', LAUNCH_REVIEW_EXPIRED],
    ['Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1', /Solana refused the launch transaction/],
  ]) {
    const { launcher, calls } = launcherWith({ send: async () => { throw refused(message) } })
    await assert.rejects(() => launcher.submit(launch), error => error instanceof DefinitiveLaunchError &&
      (typeof expected === 'string' ? error.message === expected : expected.test(error.message)))
    assert.equal(calls.confirm, 0)
  }
})

test('an unknown send outcome, or "already processed", stays ambiguous', async () => {
  for (const failure of [Error('fetch failed'), refused('Transaction simulation failed: This transaction has already been processed')]) {
    const { launcher } = launcherWith({ send: async () => { throw failure } })
    await assert.rejects(() => launcher.submit(launch), error => error === failure && !(error instanceof DefinitiveLaunchError))
  }
  const { launcher } = launcherWith({ confirm: async () => { throw new TransactionExpiredBlockheightExceededError('sig') } })
  await assert.rejects(() => launcher.submit(launch), error => !(error instanceof DefinitiveLaunchError) && /did not confirm/.test(error.message))
  const unknown = Error('fetch failed')
  const dropped = launcherWith({ confirm: async () => { throw unknown } })
  await assert.rejects(() => dropped.launcher.submit(launch), error => error === unknown)
  const shown = launchFailure(new Error('The launch was sent but did not confirm before its transaction expired.'), 'submit')
  assert.deepEqual([shown.canRetry, shown.code], [false, 'REVIEW_EXPIRED'])
})

test('a sent launch is confirmed; one that failed on chain is definitive', async () => {
  const ok = launcherWith()
  await ok.launcher.submit(launch)
  assert.deepEqual(ok.calls, { send: 1, confirm: 1 })
  const failed = launcherWith({ confirm: async () => ({ value: { err: { InstructionError: [2, 'Custom'] } } }) })
  await assert.rejects(() => failed.launcher.submit(launch), DefinitiveLaunchError)
})

test('launch errors are classified by name, which survives the production build renaming classes', () => {
  // As the minified build emits it: `class d extends Error`, with the name set in the constructor.
  const renamed = new (class d extends Error { constructor(message) { super(message); this.name = 'DefinitiveLaunchError' } })(LAUNCH_REVIEW_EXPIRED)
  for (const error of [renamed, new DefinitiveLaunchError(LAUNCH_REVIEW_EXPIRED)]) {
    assert.deepEqual(launchFailure(error, 'submit'), { error: LAUNCH_REVIEW_EXPIRED, canRetry: true, code: 'REVIEW_EXPIRED' })
  }
  assert.equal(new DefinitiveLaunchError('x').name, 'DefinitiveLaunchError')
  const incomplete = new IncompleteLaunchError('This repository has an incomplete launch (ambiguous) that is still being checked on Solana.')
  assert.equal(incomplete.name, 'IncompleteLaunchError')
  assert.deepEqual([launchFailure(incomplete, 'prepare').canRetry, launchFailure(incomplete, 'prepare').code], [false, 'CHECK_STATUS'])
  assert.equal(launchFailure(Error('fetch failed'), 'submit').canRetry, false)
})
