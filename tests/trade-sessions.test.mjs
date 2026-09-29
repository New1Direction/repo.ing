import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import bs58 from 'bs58'
import { Connection, Keypair, Message, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import { createCanonicalTrader } from '../src/canonical-trade.mjs'
import { createDammTrader, createTradeRouter } from '../src/canonical-damm-trade.mjs'
import { LIGHTHOUSE_PROGRAM } from '../src/launch-wallet-assertions.mjs'
import { normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { preparedFromRecord, readTradeRecord, serializeUnsigned, TRADE_RECORD_VERSION } from '../src/trade-record.mjs'
import { acceptSignedTrade, createTradeSessionStore, SESSION_TTL_MS, SUBMIT_WINDOW_MS, TRADE_WINDOW_CLOSED } from '../src/trade-sessions.mjs'

// A real finalized $REPOING DAMM buy (mainnet), including its real wallet signature: the "wallet" in these tests.
const swaps = JSON.parse(readFileSync(new URL('./fixtures/repoing-damm-swaps.json', import.meta.url), 'utf8'))
const CONFIG = Keypair.generate().publicKey.toBase58()
const CURVE = Keypair.generate().publicKey.toBase58()
const MINT = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'
const pool = new PublicKey(swaps.pool)
const rpc = new Connection('http://127.0.0.1:8909')

// In-memory stand-in for the trade_sessions statements (the real SQL runs in trade-sessions-db.test.mjs).
function fakeDb() {
  const rows = new Map(), calls = []
  const view = row => ({ id: row.id, wallet: row.wallet, record: structuredClone(row.record), createdAt: String(row.created_at.getTime()),
    signature: row.signature, signedMessage: row.signed_message, submittedAt: row.submitted_at ? String(row.submitted_at.getTime()) : null,
    result: row.result ? structuredClone(row.result) : null })
  return { rows, calls, async query(sql, params) {
    calls.push(sql.trim().split(/\s+/).slice(0, 3).join(' '))
    if (sql.startsWith('insert into trade_sessions')) {
      if (rows.has(params[0])) throw Object.assign(Error('duplicate'), { code: '23505' })
      rows.set(params[0], { id: params[0], wallet: params[1], record: JSON.parse(params[11]), created_at: params[12], signature: null,
        signed_message: null, submitted_at: null, result: null })
      return { rowCount: 1, rows: [] }
    }
    if (sql.startsWith('select')) { const row = rows.get(params[0]); return { rows: row ? [view(row)] : [] } }
    if (sql.startsWith('update trade_sessions set signature')) {
      const row = rows.get(params[0])
      if (!row || (row.signature && row.signature !== params[1])) return { rows: [] }
      Object.assign(row, { signature: params[1], signed_message: params[2], submitted_at: row.submitted_at ?? params[3] })
      return { rows: [view(row)] }
    }
    if (sql.startsWith('update trade_sessions set result')) {
      const row = rows.get(params[0])
      if (row?.signature === params[2]) row.result = JSON.parse(params[1])
      return { rowCount: row ? 1 : 0 }
    }
    if (sql.startsWith('delete from trade_sessions')) {
      let rowCount = 0
      for (const [id, row] of rows) if (row.created_at < params[0]) { rows.delete(id); rowCount++ }
      return { rowCount }
    }
    throw Error(`unexpected SQL ${sql}`)
  } }
}

const clock = (start = 1_800_000_000_000) => {
  let t = start
  return Object.assign(() => t, { set: value => { t = value } })
}

// The fixture buy as its own prepared DAMM record: exactly what prepare would have stored for this wallet.
function dammFixtureRecord() {
  const raw = swaps.buy, message = new Message(raw.transaction.message)
  const unsigned = Transaction.populate(message, [bs58.encode(Buffer.alloc(64))])
  const keys = message.accountKeys
  const swap = raw.transaction.message.instructions.find(ix => keys[ix.programIdIndex].toBase58().startsWith('cpamdp'))
  const data = Buffer.from(bs58.decode(swap.data))
  return { v: TRADE_RECORD_VERSION, phase: 'graduated', direction: 'buy', wallet: keys[0].toBase58(), marketId: 7,
    githubRepoId: '1388219884', mint: MINT, curve: CURVE, pool: swaps.pool,
    tokenAVault: keys[swap.accounts[4]].toBase58(), tokenBVault: keys[swap.accounts[5]].toBase58(), referral: null, wsolRent: null,
    amountIn: data.readBigUInt64LE(8).toString(), minimumAmountOut: data.readBigUInt64LE(16).toString(),
    message: Buffer.from(message.serialize()).toString('base64'), transaction: serializeUnsigned(unsigned),
    blockhash: message.recentBlockhash, lastValidBlockHeight: 400_000_000, slippageBps: 100,
    priorityFee: { computeUnitLimit: 120_000, microLamports: 200_000, lamports: '24000' } }
}
const signedFixture = () => Transaction.populate(new Message(swaps.buy.transaction.message), [swaps.buy.transaction.signatures[0]])

// A chain that accepts the broadcast and reports it confirmed; receipts come from the injected loadTransaction.
function landingChain() {
  const sent = []
  const connection = Object.assign(Object.create(rpc), {
    sendRawTransaction: async raw => { sent.push(Buffer.from(raw).toString('base64')); return swaps.buy.transaction.signatures[0] },
    getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }),
    getBlockHeight: async () => 1, confirmTransaction: async () => ({ value: { err: null } }),
  })
  return { connection, sent }
}

function dammTrader(connection) {
  return createDammTrader({ pool: null, connection, config: CONFIG,
    graduatedFees: { destination: async () => ({ target: pool }) },
    loadTransaction: async (_, signature) => normalizeFinalizedTransaction(structuredClone(swaps.buy), signature),
    loadMarket: async () => ({ id: 7, githubRepoId: 1388219884n, mint: MINT, pool: CURVE, status: 'confirmed' }) })
}

test('a record round-trips through JSON to the same transaction bytes and refuses tampering', () => {
  const record = dammFixtureRecord()
  const prepared = preparedFromRecord(JSON.parse(JSON.stringify(record)))
  assert.equal(serializeUnsigned(prepared.transaction), record.transaction)
  assert.equal(Buffer.from(prepared.transaction.serializeMessage()).toString('base64'), record.message)
  assert.equal(prepared.amountIn, 30_000_000n)
  assert.equal(prepared.phase, 'graduated')
  assert.throws(() => readTradeRecord(record, 'curve'), /not prepared by this trader/)
  const other = Transaction.populate(new Message({ ...swaps.buy.transaction.message, recentBlockhash: Keypair.generate().publicKey.toBase58() }),
    [bs58.encode(Buffer.alloc(64))])
  for (const patch of [{ v: 2 }, { amountIn: '-1' }, { amountIn: '18446744073709551616' }, { wallet: 'not-a-key' }, { direction: 'swap' },
    { transaction: serializeUnsigned(other) }, { message: Buffer.from(other.serializeMessage()).toString('base64') },
    { signedMessage: Buffer.from(other.serializeMessage()).toString('base64') }]) {
    assert.throws(() => readTradeRecord({ ...record, ...patch }, 'graduated'), /not prepared by this trader/, JSON.stringify(Object.keys(patch)))
  }
})

test('a prepared DAMM trade survives a restart: another instance submits and verifies it from the stored row', async () => {
  const db = fakeDb(), now = clock(), id = randomUUID()
  // Instance A prepares and persists, then "restarts": nothing in memory survives.
  const before = createTradeRouter({ curve: {}, graduated: dammTrader(rpc) })
  const storeA = createTradeSessionStore({ db, engineFor: before.forPhase, now })
  await storeA.create(id, { prepared: preparedFromRecord(dammFixtureRecord()), wallet: dammFixtureRecord().wallet })
  // Instance B: fresh trader, fresh cache, only the database row.
  const { connection, sent } = landingChain()
  const after = createTradeRouter({ curve: {}, graduated: dammTrader(connection) })
  const storeB = createTradeSessionStore({ db, engineFor: after.forPhase, now })
  now.set(now() + 30_000)
  const loaded = await storeB.load(id)
  assert.equal(loaded.engine, after.forPhase('graduated'))
  const signed = signedFixture()
  const accepted = acceptSignedTrade(loaded, signed.serialize().toString('base64'), now())
  assert.equal(accepted.signature, swaps.buy.transaction.signatures[0])
  const session = await storeB.markSubmitted(loaded, accepted)
  const result = await session.engine.submitTrade(session.prepared, async () => accepted.signed)
  assert.equal(sent[0], signed.serialize().toString('base64'))
  assert.equal(result.signature, swaps.buy.transaction.signatures[0])
  assert.equal(result.tokenDelta, 53_186_326_140n)
  // A third instance (status poll) verifies from the row alone, including the stored signed message.
  const storeC = createTradeSessionStore({ db, engineFor: createTradeRouter({ curve: {}, graduated: dammTrader(connection) }).forPhase, now })
  const polled = await storeC.load(id)
  assert.equal(polled.signature, accepted.signature)
  assert.equal((await polled.engine.verifyTrade(polled.prepared, polled.signature)).quoteAmount, 30_000_000n)
  await storeC.saveResult(polled, { state: 'confirmed', signature: polled.signature, tokenDelta: '1' })
  assert.equal((await createTradeSessionStore({ db, engineFor: after.forPhase, now }).load(id)).result.tokenDelta, '1')
})

test('after a restart a wrong wallet, altered transaction, second signature or late submit is still refused', async () => {
  const db = fakeDb(), now = clock(), id = randomUUID()
  const router = createTradeRouter({ curve: {}, graduated: dammTrader(rpc) })
  await createTradeSessionStore({ db, engineFor: router.forPhase, now }).create(id, { prepared: preparedFromRecord(dammFixtureRecord()), wallet: dammFixtureRecord().wallet })
  const store = createTradeSessionStore({ db, engineFor: router.forPhase, now })
  const session = await store.load(id)
  // Someone else's valid, fully signed transaction.
  const stranger = Keypair.generate()
  const foreign = new Transaction({ feePayer: stranger.publicKey, recentBlockhash: swaps.buy.transaction.message.recentBlockhash })
    .add(SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: stranger.publicKey, lamports: 1 }))
  foreign.sign(stranger)
  assert.throws(() => acceptSignedTrade(session, foreign.serialize().toString('base64'), now()), /altered or unsigned/)
  // The reviewed message with an extra instruction (not a Lighthouse assertion): the signature no longer matters.
  const altered = Transaction.populate(new Message(swaps.buy.transaction.message))
    .add(SystemProgram.transfer({ fromPubkey: altered_payer(), toPubkey: stranger.publicKey, lamports: 5 }))
  assert.throws(() => acceptSignedTrade(session, altered.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), now()), /altered or unsigned/)
  // Unsigned reviewed message.
  assert.throws(() => acceptSignedTrade(session, dammFixtureRecord().transaction, now()), /altered or unsigned/)
  // The session wallet itself is part of the check.
  assert.throws(() => acceptSignedTrade({ ...session, wallet: stranger.publicKey.toBase58() }, signedFixture().serialize().toString('base64'), now()), /altered or unsigned/)
  // A different signature already recorded by another replica wins; this one is refused before broadcast.
  const accepted = acceptSignedTrade(session, signedFixture().serialize().toString('base64'), now())
  db.rows.get(id).signature = bs58.encode(Buffer.alloc(64, 7))
  await assert.rejects(store.markSubmitted(session, accepted), /different signature/)
  // The trader itself refuses a record with a swapped wallet even if a caller skipped the route check.
  const trader = dammTrader(landingChain().connection)
  const forged = preparedFromRecord({ ...dammFixtureRecord(), wallet: stranger.publicKey.toBase58() })
  await assert.rejects(trader.submitTrade(forged, async () => signedFixture()), /altered or unsigned/)
  await assert.rejects(trader.submitTrade({ ...forged, record: undefined }, async () => signedFixture()), /not prepared by this trader/)
  // The 2-minute submit window still applies to a rehydrated session.
  now.set(now() + SUBMIT_WINDOW_MS + 1)
  const late = await store.load(id)
  assert.throws(() => acceptSignedTrade(late, signedFixture().serialize().toString('base64'), now()),
    error => error.code === TRADE_WINDOW_CLOSED)
})
const altered_payer = () => new PublicKey(swaps.buy.transaction.message.accountKeys[0])

test('a wallet-appended Lighthouse assertion is accepted, stored, and restored for verification', async () => {
  const db = fakeDb(), now = clock(), id = randomUUID(), wallet = Keypair.generate()
  const blockhash = Keypair.generate().publicKey.toBase58()
  const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash })
    .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 10 }))
  const record = { v: TRADE_RECORD_VERSION, phase: 'curve', direction: 'buy', wallet: wallet.publicKey.toBase58(), marketId: 1, githubRepoId: '42',
    mint: MINT, pool: CURVE, referral: null, wsolRent: null, amountIn: '10000000', minimumAmountOut: '1',
    message: Buffer.from(tx.serializeMessage()).toString('base64'), transaction: serializeUnsigned(tx), blockhash, lastValidBlockHeight: 100,
    slippageBps: 100, priorityFee: null }
  const curve = { name: 'curve' }, router = createTradeRouter({ curve, graduated: {} })
  await createTradeSessionStore({ db, engineFor: router.forPhase, now }).create(id, { prepared: preparedFromRecord(record), wallet: record.wallet })
  const store = createTradeSessionStore({ db, engineFor: router.forPhase, now })
  const session = await store.load(id)
  assert.equal(session.engine, curve)
  const asserted = Transaction.from(Buffer.from(record.transaction, 'base64')).add(new TransactionInstruction({ programId: new PublicKey(LIGHTHOUSE_PROGRAM),
    keys: [{ pubkey: wallet.publicKey, isSigner: false, isWritable: false }], data: Buffer.from([5, 0, 2, ...Buffer.alloc(32), 0]) }))
  asserted.sign(wallet)
  const accepted = acceptSignedTrade(session, asserted.serialize().toString('base64'), now())
  await store.markSubmitted(session, accepted)
  const restored = await createTradeSessionStore({ db, engineFor: router.forPhase, now }).load(id)
  assert.equal(restored.prepared.record.signedMessage, accepted.signedMessage)
  assert.equal(readTradeRecord(restored.prepared.record, 'curve').signedMessage.toString('base64'), accepted.signedMessage)
})

test('a curve trade prepared before a restart is broadcast by a fresh trader from its record alone', async () => {
  const wallet = Keypair.generate(), blockhash = Keypair.generate().publicKey.toBase58()
  const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash })
    .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 10 }))
  const record = { v: TRADE_RECORD_VERSION, phase: 'curve', direction: 'buy', wallet: wallet.publicKey.toBase58(), marketId: 3, githubRepoId: '42',
    mint: MINT, pool: CURVE, referral: null, wsolRent: null, amountIn: '10000000', minimumAmountOut: '1',
    message: Buffer.from(tx.serializeMessage()).toString('base64'), transaction: serializeUnsigned(tx), blockhash, lastValidBlockHeight: 100,
    slippageBps: 100, priorityFee: null }
  const sent = [], reads = []
  const connection = Object.assign(Object.create(rpc), {
    sendRawTransaction: async raw => { sent.push(Buffer.from(raw)); return 'sig' },
    getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }),
    getBlockHeight: async () => 1, confirmTransaction: async args => { reads.push(args); return { value: { err: null } } },
    getTransaction: async () => null,
  })
  const trader = createCanonicalTrader({ pool: {}, connection, config: CONFIG,
    loadMarket: async () => ({ id: 3, githubRepoId: 42n, mint: MINT, pool: CURVE }) })
  const prepared = preparedFromRecord(JSON.parse(JSON.stringify(record)))
  // The market pins in the record are checked first; the fake market here is not a real DBC pool so it fails there.
  await assert.rejects(trader.submitTrade(prepared, async t => { t.sign(wallet); return t }), /approved DBC config|missing or failed/)
  assert.equal(sent.length, 1)
  assert.equal(reads[0].blockhash, blockhash)
  assert.equal(reads[0].lastValidBlockHeight, 100)
  await assert.rejects(trader.submitTrade(prepared, async t => { const other = Keypair.generate(); t.feePayer = other.publicKey; t.sign(other); return t }),
    /altered or unsigned/)
  assert.equal(sent.length, 1)
})

test('sessions expire after the TTL, cleanup deletes old rows, and a database outage keeps trading in-process', async () => {
  const db = fakeDb(), now = clock(), router = createTradeRouter({ curve: {}, graduated: dammTrader(rpc) })
  const store = createTradeSessionStore({ db, engineFor: router.forPhase, now, log: () => {} })
  const oldId = randomUUID()
  await store.create(oldId, { prepared: preparedFromRecord(dammFixtureRecord()), wallet: dammFixtureRecord().wallet })
  now.set(now() + SESSION_TTL_MS + 1)
  assert.equal(await store.load(oldId), null)
  assert.equal(await createTradeSessionStore({ db, engineFor: router.forPhase, now }).load(oldId), null)
  assert.equal(await store.cleanup(), 1)
  assert.equal(db.rows.size, 0)
  assert.equal(await store.cleanup(), 0) // throttled to once a minute
  assert.equal(await store.load('not-a-uuid'), null)
  // Database down: prepare still works for this process, and submit bookkeeping stays in memory.
  const down = { query: async () => { throw Object.assign(Error('down'), { code: 'ECONNREFUSED' }) } }
  const offline = createTradeSessionStore({ db: down, engineFor: router.forPhase, now, log: () => {} })
  const id = randomUUID()
  await offline.create(id, { prepared: preparedFromRecord(dammFixtureRecord()), wallet: dammFixtureRecord().wallet })
  const session = await offline.load(id)
  assert.equal(session.memoryOnly, true)
  const accepted = acceptSignedTrade(session, signedFixture().serialize().toString('base64'), now())
  const submitted = await offline.markSubmitted(session, accepted)
  assert.equal(submitted.signature, accepted.signature)
  await assert.rejects(offline.markSubmitted(submitted, { ...accepted, signature: bs58.encode(Buffer.alloc(64, 1)) }), /different signature/)
  assert.equal((await offline.saveResult(submitted, { state: 'confirmed', signature: accepted.signature })).result.state, 'confirmed')
})
