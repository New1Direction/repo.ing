import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import BN from 'bn.js'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CU_LIMIT_CEILING, CU_PRICE_MAX, LAMPORTS_PER_SIGNATURE, MAX_PRIORITY_FEE_LAMPORTS, PAYOUT_DUST_FEE_MULTIPLE,
  isDustPayout, maxPayoutNetworkFee, priorityFeeLamports, readTradeComputeBudget, signedWithPriorityFee } from '../src/trade-landing.mjs'
import { DBC_MAX_NETWORK_FEE_LAMPORTS, settleDbcPlatformClaim } from '../src/platform-dbc-fees.mjs'
import { settlePlatformClaim } from '../src/platform-fees.mjs'
import { platformFeeReview } from '../src/platform-fee-operations.mjs'
import { PARTNER_WALLET, claimOne } from '../src/platform-sweep.mjs'

const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const blockhash = Keypair.generate().publicKey.toBase58()
const rpc = (price = 2_000_000, units = 120_000) => ({ rpcEndpoint: 'http://127.0.0.1:8899',
  simulateTransaction: async () => ({ value: { err: null, unitsConsumed: units } }),
  getRecentPrioritizationFees: async () => [{ slot: 1, prioritizationFee: price }] })
// Base fee per signature + ceil(limit × price / 1e6): the same rule the runtime uses for meta.fee and getFeeForMessage.
const networkFee = tx => {
  const budget = readTradeComputeBudget(tx.instructions)
  return BigInt(tx.signatures.length) * LAMPORTS_PER_SIGNATURE + priorityFeeLamports({ units: budget.limit, microLamports: budget.microLamports })
}

// A DBC-claim-shaped transaction: partner (fee payer) and a temporary authority both sign.
function dbcClaim() {
  const partner = Keypair.generate(), temporary = Keypair.generate(), treasury = Keypair.generate().publicKey
  const pool = Keypair.generate().publicKey, quoteVault = Keypair.generate().publicKey
  const tx = new Transaction().add(
    new TransactionInstruction({ programId: DBC, data: Buffer.from([1]), keys: [
      { pubkey: pool, isSigner: false, isWritable: true }, { pubkey: quoteVault, isSigner: false, isWritable: true },
      { pubkey: partner.publicKey, isSigner: true, isWritable: false }, { pubkey: temporary.publicKey, isSigner: true, isWritable: true }] }),
    SystemProgram.transfer({ fromPubkey: temporary.publicKey, toPubkey: treasury, lamports: 1 }))
  return { partner, temporary, treasury, pool, quoteVault, tx }
}

test('payout fee ceilings: DBC reviewed max covers two base fees plus the worst priority fee, within the trade cap', () => {
  const worst = priorityFeeLamports({ units: CU_LIMIT_CEILING, microLamports: CU_PRICE_MAX })
  assert.equal(worst, 800_000n)
  assert.ok(worst <= MAX_PRIORITY_FEE_LAMPORTS)
  assert.equal(maxPayoutNetworkFee(1), 805_000n)
  assert.equal(DBC_MAX_NETWORK_FEE_LAMPORTS, 2n * LAMPORTS_PER_SIGNATURE + worst)
  const review = platformFeeReview({ sessionId: 's', repoId: '7', phase: 'DBC', data: { available: '9', termsHash: 'h', receiver: 'R' },
    partner: Keypair.generate().publicKey, now: 0 })
  assert.equal(review.maxNetworkFeeLamports, String(DBC_MAX_NETWORK_FEE_LAMPORTS))
  assert.equal(platformFeeReview({ sessionId: 's', repoId: '7', phase: 'DAMM', data: { available: '9' }, partner: Keypair.generate().publicKey, now: 0 }).maxNetworkFeeLamports, undefined)
})

test('DBC two-signer rebuild: [limit, price, ...claim], both signatures valid, fee within the reviewed ceiling', async () => {
  const { partner, temporary, tx } = dbcClaim()
  const landing = await signedWithPriorityFee(rpc(50_000_000, 5_000_000), tx, { feePayer: partner.publicKey, blockhash,
    signers: [partner, temporary], log: () => {} })
  const signed = landing.transaction
  assert.deepEqual(signed.instructions.slice(0, 2).map(ix => ix.programId.toBase58()), Array(2).fill(ComputeBudgetProgram.programId.toBase58()))
  assert.deepEqual(signed.instructions.slice(2), tx.instructions)
  assert.equal(signed.signatures.length, 2)
  assert.ok(signed.verifySignatures())
  const roundTrip = Transaction.from(signed.serialize())
  assert.ok(roundTrip.verifySignatures())
  assert.deepEqual(roundTrip.signatures.map(s => s.publicKey.toBase58()), [partner.publicKey.toBase58(), temporary.publicKey.toBase58()])
  // Clamped to the ceiling even for an absurd simulation and fee market.
  assert.equal(landing.computeUnitLimit, CU_LIMIT_CEILING)
  assert.equal(landing.microLamports, CU_PRICE_MAX)
  assert.equal(networkFee(signed), DBC_MAX_NETWORK_FEE_LAMPORTS)
  assert.ok(networkFee(signed) <= DBC_MAX_NETWORK_FEE_LAMPORTS)
  // The input transaction is not mutated.
  assert.equal(tx.instructions.length, 2)
})

test('rebuild refuses a missing signer, a fee payer that does not sign first, and a pre-set compute budget', async () => {
  const { partner, temporary, tx } = dbcClaim()
  const opts = { feePayer: partner.publicKey, blockhash, log: () => {} }
  await assert.rejects(signedWithPriorityFee(rpc(), tx, { ...opts, signers: [partner] }), /unknown signer|incomplete|Signature verification/i)
  await assert.rejects(signedWithPriorityFee(rpc(), tx, { ...opts, signers: [temporary, partner] }), /fee payer must sign first/)
  const budgeted = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }), ...tx.instructions)
  await assert.rejects(signedWithPriorityFee(rpc(), budgeted, { ...opts, signers: [partner, temporary] }), /exactly once/)
})

test('dust: a claim under 20× its network fee is skipped', () => {
  assert.equal(PAYOUT_DUST_FEE_MULTIPLE, 20n)
  assert.equal(isDustPayout(20n * 810_000n - 1n, 810_000n), true)
  assert.equal(isDustPayout(20n * 810_000n, 810_000n), false)
  assert.equal(isDustPayout('1000000', '25000'), false)
  assert.equal(isDustPayout('499999', '25000'), true)
})

test('sweep reports a service-side dust skip without treating it as claimed', async () => {
  const claimed = []
  const service = { status: async () => ({ enrolled: true, available: '5000000' }),
    claim: async ({ review }) => { claimed.push(review); return { status: 'skipped-dust', broadcast: false, networkFee: '810000' } } }
  const result = await claimOne({ repoId: '1', phase: 'DAMM' }, { feeService: () => service, partner: { publicKey: new PublicKey(PARTNER_WALLET) } })
  assert.equal(claimed.length, 1)
  assert.deepEqual({ status: result.status, networkFee: result.networkFee, available: result.available }, { status: 'skipped-dust', networkFee: '810000', available: '5000000' })
})

test('DAMM settlement with a priority fee: claimed = receiver delta + meta.fee exactly', async () => {
  const receiver = Keypair.generate().publicKey, fee = 5000 + 800_000
  const connection = { getTransaction: async () => ({ meta: { err: null, fee, preBalances: [50_000_000], postBalances: [50_000_000 + 400_000_000 - fee] },
    transaction: { message: { accountKeys: [receiver] } } }) }
  const db = { query: async (sql, params) => ({ rows: [{ status: 'settled', signature: params[0], amount: params[1] }] }) }
  const settled = await settlePlatformClaim(db, connection, { signature: 'sig', wallet: receiver.toBase58(), amount: '400000000' })
  assert.equal(settled.amount, '400000000')
})

// A finalized receipt for the signed DBC intent, with priority-inclusive meta.fee.
async function dbcReceipt({ fee, treasuryDelta, sourceDelta, amount = 50_000_000n }) {
  const { partner, temporary, treasury, pool, quoteVault, tx } = dbcClaim()
  const { transaction: signed } = await signedWithPriorityFee(rpc(), tx, { feePayer: partner.publicKey, blockhash, signers: [partner, temporary], log: () => {} })
  const message = signed.compileMessage(), keys = message.accountKeys, at = key => keys.findIndex(k => k.equals(key))
  const program = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:1'), 'finalized').state.getProgram()
  const event = Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'),
    Buffer.from(program.idl.events.find(e => e.name === 'evtClaimTradingFee').discriminator),
    program.coder.types.encode('evtClaimTradingFee', { pool, tokenBaseAmount: new BN(0), tokenQuoteAmount: new BN(amount.toString()) })])
  const pre = keys.map(() => 1_000_000_000), post = [...pre]
  post[at(treasury)] += Number(treasuryDelta); post[at(partner.publicKey)] += Number(sourceDelta)
  pre[at(temporary.publicKey)] = 0; post[at(temporary.publicKey)] = 0
  const vault = balance => [{ accountIndex: at(quoteVault), mint: NATIVE_MINT.toBase58(), uiTokenAmount: { amount: String(balance) } }]
  const receipt = { slot: 9, transaction: { signatures: [bs58.encode(signed.signature)], message },
    meta: { err: null, fee: Number(fee), preBalances: pre, postBalances: post,
      preTokenBalances: vault(amount + 7n), postTokenBalances: vault(7n),
      innerInstructions: [{ index: 2, instructions: [{ programIdIndex: at(DBC), data: bs58.encode(event) }] }] } }
  const evidence = { phase: 'DBC', receiver: treasury.toBase58(), pool: pool.toBase58(), available: String(amount),
    source: partner.publicKey.toBase58(), networkFee: String(networkFee(signed)), quoteVault: quoteVault.toBase58(),
    temporaryAccounts: [temporary.publicKey.toBase58()] }
  const intent = { signature: bs58.encode(signed.signature), signedTransaction: signed.serialize().toString('base64'),
    wallet: treasury.toBase58(), amount: String(amount), pool: pool.toBase58(), phase: 'DBC', evidence: JSON.stringify(evidence) }
  return { intent, fee: networkFee(signed), connection: { getTransaction: async () => receipt } }
}
const noopDb = { query: async () => ({ rows: [] }) }

test('DBC settlement holds exact SOL deltas when meta.fee includes the priority fee', async () => {
  const probe = await dbcReceipt({ fee: 0n, treasuryDelta: 0n, sourceDelta: 0n })
  const fee = probe.fee
  assert.ok(fee > 2n * LAMPORTS_PER_SIGNATURE && fee <= DBC_MAX_NETWORK_FEE_LAMPORTS)
  const ok = await dbcReceipt({ fee, treasuryDelta: 50_000_000n, sourceDelta: -fee })
  const receipt = await settleDbcPlatformClaim(noopDb, ok.connection, ok.intent)
  assert.equal(receipt.reconciliation, 'MATCH')
  assert.equal(receipt.networkFee, String(fee))
  // Evidence recorded only the base fee: the priority-inclusive meta.fee no longer matches.
  const baseOnly = await dbcReceipt({ fee, treasuryDelta: 50_000_000n, sourceDelta: -fee })
  const evidence = JSON.parse(baseOnly.intent.evidence)
  await assert.rejects(settleDbcPlatformClaim(noopDb, baseOnly.connection, { ...baseOnly.intent,
    evidence: JSON.stringify({ ...evidence, networkFee: '10000' }) }), /Exact treasury or signer SOL delta mismatch/)
  // The signer paying only the base fee (priority unaccounted) is a mismatch.
  const short = await dbcReceipt({ fee, treasuryDelta: 50_000_000n, sourceDelta: -10_000n })
  await assert.rejects(settleDbcPlatformClaim(noopDb, short.connection, short.intent), /delta mismatch/)
})

test('a payout that would overflow the packet with both budget ixs keeps only a capped price and fits', async () => {
  const { signedWithPriorityFee, PACKET_DATA_SIZE, MAX_PAYOUT_PRIORITY_FEE_LAMPORTS } = await import('../src/trade-landing.mjs')
  const { Keypair: K, Transaction: T, TransactionInstruction: I, PublicKey: P } = await import('@solana/web3.js')
  const payer = K.generate(), program = new P('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo')
  const connection = { rpcEndpoint: 'http://127.0.0.1:8899',
    simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 150_000 } }),
    getRecentPrioritizationFees: async () => [{ slot: 1, prioritizationFee: 2_000_000 }] }
  const build = bytes => new T().add(new I({ programId: program, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }], data: Buffer.alloc(bytes, 1) }))
  const size = tx => { const m = tx.compileMessage(); return 1 + 64 * m.header.numRequiredSignatures + m.serialize().length }
  // Find a payload that fits with a price ix only but not with limit + price.
  let bytes = 900, landing
  for (; bytes < 1200; bytes++) {
    landing = await signedWithPriorityFee(connection, build(bytes), { feePayer: payer.publicKey, blockhash: '11111111111111111111111111111111', signers: [payer], log: () => {} })
    if (landing.limitDropped) break
  }
  assert.equal(landing.limitDropped, true)
  assert.ok(size(landing.transaction) <= PACKET_DATA_SIZE)
  assert.ok(landing.priorityFeeLamports <= MAX_PAYOUT_PRIORITY_FEE_LAMPORTS)
  assert.equal(landing.transaction.instructions.filter(ix => ix.programId.toBase58() === 'ComputeBudget111111111111111111111111111111').length, 1)
  assert.ok(landing.transaction.verifySignatures())
})
