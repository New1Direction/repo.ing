import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { curveFixture, curveObservations, curveRpc } from './fixtures/hooklab-curve.mjs'
import { buildCurveInstruction, prepareCurveReview, mergeCurveSignatures, simulateCurveReview,
  submitCurveTransaction, CURVE_PROFILE } from '../src/hooklab-curve.mjs'
import { inspectCurveReceipt, readCurveReceipt } from '../src/hooklab-curve-receipts.mjs'
import { curveActivationStatus, inspectCurveTrialProposal } from '../src/hooklab-curve-activation.mjs'

test('production plain buy/sell: exact source ABI, independent PDA metas, asymmetric recipients and amounts', () => {
  for (const side of ['buy', 'sell']) for (const payerSame of [true, false]) {
    const f = curveFixture({ side, payerSame }), a = f.addresses
    const ix = buildCurveInstruction(f.intent, f.observed)
    assert.equal(ix.programId.toBase58(), 'B2crxUdFwow36hy2KDbkiQro75mtLA4cN4pwDeQpZJwk')
    assert.equal(ix.data.toString('hex'), side === 'buy'
      ? 'f8c69e91e17587c80165000000000000009402000000000000000000000000'
      : 'f8c69e91e17587c80089000000000000001300000000000000000000000000')
    const expected = [f.intent.trader, a.swapConfig, a.pool, a.mint, a.quoteMint, a.baseVault, a.quoteVault,
      a.traderBase, a.traderQuote, 'E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft',
      'HCmLYfqxHucGpyWKBm7ohFjW3Q6MjWARg8gUTP3W6snW', '2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22',
      '69vhpnkYjtiJgdfU7QsA5Ww7V8FWtvPcZ2r4znuyByvq', 'HrT36WiC3r5SbnmBRPWgZVPfBtevgMfCRTV11EqEMqMP',
      'B2crxUdFwow36hy2KDbkiQro75mtLA4cN4pwDeQpZJwk', a.launch, a.launchQuote, a.holderVault, a.kitConfig]
    assert.deepEqual(ix.keys.map(k => k.pubkey.toBase58()), expected.map(k => new PublicKey(k).toBase58()))
    assert.deepEqual(ix.keys.map(k => k.isSigner), [true, ...Array(18).fill(false)])
    assert.deepEqual(ix.keys.map(k => k.isWritable), [false, false, true, false, false, true, true, true, true,
      false, false, false, false, false, false, true, true, true, false])
    assert.equal(f.plan.review.requiredSigners.length, payerSame ? 1 : 2)
    assert.equal(f.plan.candidateOutput, side === 'buy' ? '667' : '20')
    assert.equal(f.plan.review.lookupTables.length, 0)
    assert.equal(f.plan.canSign, false); assert.equal(f.plan.policyAccepted, false)
  }
})

test('curve policy rejects paused, fees, hooks, wrong placeholders, foreign holdings and unsafe economics', () => {
  const f = curveFixture()
  for (const [role, fields] of [
    ['swapConfig', { paused: true }], ['swapConfig', { launch_protocol_share_bps: 1 }],
    ['pool', { lp_fee_bps: 1 }], ['pool', { hook_program: null }], ['pool', { fee_model: 0 }],
    ['pool', { quote_reserve: 9001 }], ['launch', { sniper_start_bps: 1 }],
    ['launch', { modules: 1 }], ['launch', { custom_hook: f.trader.publicKey }],
    ['launch', { kit_config: f.trader.publicKey }], ['launch', { holder_vault: f.trader.publicKey }],
    ['launch', { rules: { burn_sell_bps: 1 } }], ['launch', { graduation_quote: 9101 }],
    ['mint', { hook_program: f.trader.publicKey }], ['traderBase', { owner: f.trader.publicKey }],
    ['traderQuote', { frozen: true }], ['traderQuote', { amount: 100 }], ['pool', { swap_count: 0xffffffffffffffffn }],
  ]) {
    const s = structuredClone(f.observed); f.patchAccount(role, fields, s.accounts)
    assert.throws(() => prepareCurveReview(f.intent, s), undefined, `${role} ${Object.keys(fields)}`)
  }
  for (const fields of [{ minAmountOut: '0' }, { minAmountOut: '668' }, { amountIn: '0' },
    { amountIn: '18446744073709551616' }, { maxInput: '100' }, { maxPriceImpactBps: 83 },
    { maxNetworkFeeLamports: '9999' }, { programs: {} }, { deadlineSlot: '130' }]) {
    assert.throws(() => prepareCurveReview({ ...f.intent, ...fields }, f.observed))
  }
  assert.equal(prepareCurveReview({ ...f.intent, minAmountOut: '667', maxPriceImpactBps: 84 }, f.observed).candidateOutput, '667')
  const sell = curveFixture({ side: 'sell' }), thin = structuredClone(sell.observed)
  sell.patchAccount('pool', { quote_reserve: 0 }, thin.accounts)
  sell.patchAccount('quoteVault', { amount: 17 }, thin.accounts)
  assert.throws(() => prepareCurveReview({ ...sell.intent, minAmountOut: '1' }, thin), /real liquidity/)
  const wrong = structuredClone(f.observed); wrong.accounts.pool.owner = f.intent.trader
  assert.throws(() => prepareCurveReview(f.intent, wrong), /identity/)
  assert.throws(() => prepareCurveReview(f.intent, { ...f.observed, lookupTables: [] }))
})

test('external partial signatures merge without loss; altered bytes, invalid signatures and execution are rejected', async () => {
  const f = curveFixture(), t = f.partial(f.trader), p = f.partial(f.payer)
  const first = mergeCurveSignatures(f.plan, null, t)
  assert.deepEqual(first.present, [f.intent.trader]); assert.equal(first.complete, false)
  const merged = mergeCurveSignatures(f.plan, first.transactionBase64, p)
  assert.equal(merged.complete, true); assert.equal(merged.transactionBase64, f.signed)
  assert.equal(mergeCurveSignatures(f.plan, merged.transactionBase64, t).transactionBase64, f.signed)
  const bad = VersionedTransaction.deserialize(Buffer.from(t, 'base64')); bad.signatures[1][0] ^= 1
  assert.throws(() => mergeCurveSignatures(f.plan, null, Buffer.from(bad.serialize()).toString('base64')), /signature/)
  const changed = structuredClone(f.plan); changed.review.lastValidBlockHeight++
  assert.throws(() => mergeCurveSignatures(changed, null, t), /plan changed/)
  assert.throws(() => mergeCurveSignatures(f.plan, null, curveFixture().signed), /message changed/)
  const connection = { sendRawTransaction() { assert.fail('broadcast attempted') } }
  await assert.rejects(submitCurveTransaction(connection, f.signed, { enabled: true, approved: true }), { status: 423 })
})

test('exact unsigned simulation rejects expiration, wallet/fee/blockhash drift and replacement', async () => {
  const f = curveFixture()
  const connection = { getGenesisHash: async () => f.observed.genesisHash,
    simulateTransaction: async (tx, options) => {
      assert.equal(Buffer.from(tx.message.serialize()).toString('base64'), f.plan.review.messageBase64)
      assert.equal(options.replaceRecentBlockhash, false)
      return { context: { slot: 101 }, value: { err: null, unitsConsumed: 9999 } }
    } }
  assert.equal((await simulateCurveReview(connection, f.plan, f.current)).postconditionsVerified, false)
  for (const patch of [{ nowMs: 16000 }, { slot: 133 }, { blockHeight: 161 }, { blockhashValid: false },
    { feeLamports: '9999' }, { wallet: f.intent.feePayer }, { lookupTableHashes: [{ address: f.intent.mint, sha256: 'a'.repeat(64) }] }]) {
    await assert.rejects(simulateCurveReview(connection, f.plan, { ...f.current, ...patch }))
  }
  connection.simulateTransaction = async () => ({ context: { slot: 101 }, value: { err: null, unitsConsumed: 9, replacementBlockhash: {} } })
  await assert.rejects(simulateCurveReview(connection, f.plan, f.current), /replaced/)
})

test('ordered historical contract checks buy/sell accounting, refuses later poststate and never claims chain acceptance', () => {
  for (const side of ['buy', 'sell']) {
    const f = curveFixture({ side }), obs = curveObservations(f)
    const inspect = o => inspectCurveReceipt(f.plan, f.signed, o, ['alpha', 'beta'])
    const result = inspect(obs)
    assert.equal(result.status, 'candidate-deltas-matched'); assert.equal(result.chainVerified, false)
    assert.equal(result.canRetry, false); assert.equal(result.historyProvenanceVerified, false)
    assert.equal(inspect([]).status, 'unresolved')
    for (const mutate of [o => { delete o.history }, o => { o.history.kind = 'getAccountInfo' },
      o => { o.history.slot++ }, o => { o.history.messageSha256 = 'b'.repeat(64) },
      o => { f.patchAccount('pool', { swap_count: 9 }, o.history.after) },
      o => { f.patchAccount('traderBase', { amount: 1668 }, o.history.after) },
      o => { o.receipt.balances[0].after = '49999999' },
      o => { const raw = Buffer.from(o.history.after.pool.dataBase64, 'base64'); raw[410] ^= 1; o.history.after.pool.dataBase64 = raw.toString('base64') },
      o => { o.history.after.poolRegistry.dataBase64 = '' }]) {
      const bad = structuredClone(obs); bad.forEach(mutate)
      assert.equal(inspect(bad).status, 'review-required')
    }
    const disagree = structuredClone(obs); disagree[1].receipt.slot++
    assert.equal(inspect(disagree).status, 'unresolved')
    const failed = structuredClone(obs); failed.forEach(o => { o.receipt.error = { InstructionError: [2, 'Slippage'] }; delete o.history })
    assert.equal(inspect(failed).status, 'finalized-failure')
  }
})

test('read adapter retains finalized transaction through missing, failed and timed-out history without fetching later account state', async () => {
  const f = curveFixture(), connection = curveRpc(f), expected = curveObservations(f)[0]
  for (const history of [undefined, async () => { throw new Error('pruned') }, () => new Promise(() => {})]) {
    const observed = await readCurveReceipt(connection, 'alpha', f.plan, f.signed, history)
    assert.deepEqual(observed.receipt, expected.receipt)
    assert.equal(observed.history, null); assert.ok(observed.transactionResponse)
    const other = { ...observed, provider: 'beta' }
    assert.equal(inspectCurveReceipt(f.plan, f.signed, [observed, other], ['alpha', 'beta']).status, 'review-required')
  }
  const observed = await readCurveReceipt(connection, 'alpha', f.plan, f.signed, async () => expected.history)
  assert.deepEqual(observed.history, expected.history)
  await assert.rejects(readCurveReceipt({ ...connection, getGenesisHash: async () => f.intent.mint }, 'alpha', f.plan, f.signed), /network/)
  const unsafe = await connection.getTransaction(); unsafe.meta.preBalances[0] = Number.MAX_SAFE_INTEGER + 1
  await assert.rejects(readCurveReceipt({ ...connection, getTransaction: async () => unsafe }, 'alpha', f.plan, f.signed), /Unsafe RPC/)
})

test('bounded trial proposal binds exact messages, exposure, exclusive window and one buy/sell without enabling trading', () => {
  const f = curveFixture({ recipientSame: true })
  const sell = prepareCurveReview({ ...f.intent, side: 'sell', amountIn: '137', minAmountOut: '19' }, f.observed)
  const proposal = { schema: 'repoing/curve-trial-proposal/1', profileSha256: CURVE_PROFILE,
    ...Object.fromEntries(['policySha256', 'deploymentEvidenceSha256', 'provenanceEvidenceSha256', 'custodyEvidenceSha256',
      'alertDrillSha256', 'ownerApprovalSha256'].map(k => [k, 'a'.repeat(64)])),
    buyMessageSha256: f.plan.review.messageSha256, sellMessageSha256: sell.review.messageSha256,
    startsAtMs: 1000, expiresAtMs: 2000, maxQuoteInput: '101', maxBaseInput: '137', maxNetworkFeesLamports: '20000',
    maxQuoteLoss: '82', maxBuys: 1, maxSells: 1, globalUnpauseAcknowledged: true,
    rePauseNeedsSeparateApproval: true, historicalReceiptsRequired: true }
  const result = inspectCurveTrialProposal(proposal, f.plan, sell, 1500)
  assert.equal(result.status, 'proposal-bounds-matched'); assert.equal(result.boundedLiveEnabled, false)
  for (const patch of [{ maxQuoteInput: '100' }, { maxBaseInput: '136' }, { maxNetworkFeesLamports: '19999' },
    { maxQuoteLoss: '81' }, { maxBuys: 2 }, { buyMessageSha256: 'b'.repeat(64) }, { enabled: true }]) {
    assert.throws(() => inspectCurveTrialProposal({ ...proposal, ...patch }, f.plan, sell, 1500))
  }
  assert.throws(() => inspectCurveTrialProposal(proposal, f.plan, sell, 2000), /expired/)
  assert.equal(curveActivationStatus().mode, 'disabled'); assert.equal(curveActivationStatus().acceptedPolicySha256, null)
  assert.equal(curveActivationStatus().kitSupported, false); assert.equal(curveActivationStatus().customHooksSupported, false)
})
