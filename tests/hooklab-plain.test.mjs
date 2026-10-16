import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { plainFixture, plainObservations, accountBytes } from './fixtures/hooklab-plain.mjs'
import { firstCreatorPacket, preparePlainReview, simulatePlainReview, submitPlainTransaction, verifyPlainPostconditions } from '../src/hooklab-plain.mjs'
import { inspectHookLabMessage } from '../src/hooklab-message-boundary.mjs'
import { readPlainReceipt, verifyPlainReceipt, plainRecoveryInventory } from '../src/hooklab-plain-receipts.mjs'

test('inactive production candidate verifies every retained vendor asset; first packet never selects a creator or economics', () => {
  const root = new URL('../vendor/hooklab-production-candidate/', import.meta.url)
  const provenance = JSON.parse(readFileSync(new URL('provenance.json', root)))
  assert.equal(provenance.revision, 'f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32')
  for (const [file, expected] of Object.entries(provenance.files)) assert.equal(createHash('sha256').update(readFileSync(new URL(file, root))).digest('hex'), expected, file)
  const packet = firstCreatorPacket()
  for (const field of ['creator', 'feePayer', 'mint', 'economics', 'creatorGrant', 'message']) assert.equal(packet[field], null)
  assert.equal(packet.canSign, false); assert.equal(packet.canSubmit, false)
})

test('plain builder binds production program, distinct creator and fee payer; schema refuses nonplain features', () => {
  const { plan } = plainFixture(), review = inspectHookLabMessage(plan.review)
  assert.equal(review.instructions.length, 3)
  assert.equal(review.instructions[2].program, 'E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft')
  assert.equal(review.instructions[2].accounts[0].address, plan.intent.creator)
  assert.equal(plan.review.requiredSigners[0], plan.intent.feePayer)
  assert.equal(plan.review.requiredSigners.length, 3)
  assert.equal(review.totalFeeLamports, '15000')
  for (const extra of [{ creatorFeeBps: 1 }, { rules: {} }, { kit: true }, { hook: plan.intent.mint }, { directPool: true }]) {
    assert.throws(() => preparePlainReview({ ...plan.intent, ...extra }, plan.observed))
  }
  assert.throws(() => preparePlainReview({ ...plan.intent, deadlineSlot: '151' }, plan.observed), /Deadline/)
  assert.throws(() => preparePlainReview({ ...plan.intent, maxPoolCreationFeeLamports: '18' }, plan.observed), /fee/)
  assert.throws(() => preparePlainReview(plan.intent, { ...plan.observed, creatorGrant: { ...plan.observed.creatorGrant, consumed: '3' } }), /exhausted/)
  assert.throws(() => preparePlainReview(plan.intent, { ...plan.observed, slot: 151 }), /expired/)
  const raw = Buffer.from(plan.observed.launchConfigBase64, 'base64'); raw[8] = 2
  assert.throws(() => preparePlainReview(plan.intent, { ...plan.observed, launchConfigBase64: raw.toString('base64') }), /version/)
})

test('simulation uses exact bytes, no replacement, validates stale/wrong-network/failure outcomes; submit always refuses', async () => {
  const f = plainFixture(), rpc = { getGenesisHash: async () => f.plan.review.genesisHash,
    async simulateTransaction(tx, options) {
      assert.equal(Buffer.from(tx.message.serialize()).toString('base64'), f.plan.review.messageBase64)
      assert.equal(options.replaceRecentBlockhash, false)
      return { context: { slot: 101 }, value: { err: null, unitsConsumed: 252776 } }
    } }
  assert.equal((await simulatePlainReview(rpc, f.plan, f.current)).unitsConsumed, 252776)
  await assert.rejects(simulatePlainReview(rpc, f.plan, { ...f.current, blockhashValid: false }), /expired/)
  await assert.rejects(simulatePlainReview({ ...rpc, getGenesisHash: async () => 'devnet' }, f.plan, f.current), /network/)
  await assert.rejects(simulatePlainReview({ ...rpc, simulateTransaction: async () => ({ context: { slot: 101 }, value: { err: 'paused' } }) }, f.plan, f.current), /failed/)
  await assert.rejects(submitPlainTransaction({ plan: f.plan, signedBase64: f.signed, enabled: true }), { code: 'PRODUCTION_EXECUTION_DISABLED' })
})

test('synthetic receipt reconciles asymmetric fees, rent, allocation and separate/same payer without claiming deployment', () => {
  for (const samePayer of [false, true]) {
    const f = plainFixture({ samePayer }), r = verifyPlainReceipt(f.plan, f.signed, plainObservations(f), ['alpha', 'beta'])
    assert.equal(r.status, 'receipt-state-matched')
    assert.equal(r.creatorDebitLamports, '10092'); assert.equal(r.treasuryCreditLamports, '92')
    assert.equal(r.feePayerNetworkFeeLamports, samePayer ? '10000' : '15000')
    assert.equal(r.chainVerified, false); assert.equal(r.canRetry, false); assert.equal(r.canSubmit, false)
    assert.deepEqual(verifyPlainPostconditions(f.plan, f.accounts), { status: 'plain-state-matched', curveTokens: '750000000000000',
      reserveTokens: '250000000000000', quoteReserve: '0', lpSupply: '0', canSubmit: false })
  }
})

test('receipt refusal: unknown, provider disagreement, pending, failed and poststate/debit drift preserve original signature', () => {
  const f = plainFixture(), verify = observations => verifyPlainReceipt(f.plan, f.signed, observations, ['alpha', 'beta'])
  assert.equal(verify([]).status, 'unresolved')
  let obs = plainObservations(f); obs[1].receipt.slot++; assert.equal(verify(obs).status, 'unresolved')
  obs = plainObservations(f); obs.forEach(o => { o.receipt.confirmationStatus = 'confirmed' }); assert.equal(verify(obs).status, 'pending-finality')
  obs = plainObservations(f); obs.forEach(o => { o.receipt.error = { InstructionError: [2, 'Custom'] } }); assert.equal(verify(obs).status, 'finalized-failure')
  obs = plainObservations(f); obs.forEach(o => { o.receipt.slot = 150; o.snapshot.slot = 151 }); assert.equal(verify(obs).status, 'receipt-state-matched')
  for (const mutate of [
    o => { o.receipt.slot = 151; o.snapshot.slot = 152 },
    o => { o.snapshot.accounts.mint.owner = f.plan.intent.creator },
    o => { o.snapshot.slot = 103 },
    o => { const b = Buffer.from(o.snapshot.accounts.creatorGrant.dataBase64, 'base64'); b[0] ^= 1; o.snapshot.accounts.creatorGrant.dataBase64 = b.toString('base64') },
    o => { const b = Buffer.from(o.snapshot.accounts.poolRegistry.dataBase64, 'base64'); b[13] = 0; o.snapshot.accounts.poolRegistry.dataBase64 = b.toString('base64') },
    o => { o.snapshot.accounts.launchConfig.dataBase64 = accountBytes('launch', 'Config', { ...f.config, launches: 6 }, 250).toString('base64') },
    o => { o.receipt.balances.find(b => b.address === f.plan.intent.creator).after-- },
    o => { o.snapshot.accounts.baseVault.dataBase64 = accountBytes('token', 'Holding', { version: 1, mint: f.plan.intent.mint, owner: f.plan.addresses.pool, amount: 749999999999999n }, 204).toString('base64') },
  ]) {
    obs = plainObservations(f); obs.forEach(mutate)
    const result = verify(obs)
    assert.equal(result.status, 'review-required'); assert.equal(result.signature, plainObservations(f)[0].receipt.signature)
    assert.equal(result.canRetry, false)
  }
})

test('finalized read adapter resolves retained ALT account order and exact signed wire, never sends', async () => {
  const f = plainFixture(), expected = plainObservations(f)[0], message = f.tx.message
  const indexes = message.addressTableLookups[0]
  const alt = Buffer.from(f.plan.review.lookupTables[0].dataBase64, 'base64')
  const address = i => new PublicKey(alt.subarray(56 + i * 32, 88 + i * 32))
  const bs58 = (await import('bs58')).default
  const observation = await readPlainReceipt({ getGenesisHash: async () => f.plan.review.genesisHash,
    getTransaction: async () => ({ slot: 104, transaction: { message, signatures: f.tx.signatures.map(s => bs58.encode(s)) },
      meta: { err: null, fee: 15000, preBalances: f.balances.map(b => b.before), postBalances: f.balances.map(b => b.after),
        loadedAddresses: { writable: Array.from(indexes.writableIndexes, address), readonly: Array.from(indexes.readonlyIndexes, address) } } }),
    getMultipleAccountsInfoAndContext: async (keys, options) => {
      assert.equal(options.commitment, 'finalized'); assert.equal(options.minContextSlot, 104)
      assert.deepEqual(keys.map(k => k.toBase58()), Object.values(plainRecoveryInventory(f.plan)))
      return { context: { slot: 105 }, value: Object.values(plainRecoveryInventory(f.plan)).map(address => {
        const a = Object.values(f.accounts).find(a => a.address === address)
        return { owner: new PublicKey(a.owner), executable: false, data: Buffer.from(a.dataBase64, 'base64') }
      }) }
    },
  }, 'alpha', f.plan, f.signed)
  assert.deepEqual(observation, expected)
})
