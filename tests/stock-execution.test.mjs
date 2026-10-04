import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import bs58 from 'bs58'
import { ComputeBudgetProgram, Keypair, SystemProgram, Transaction } from '@solana/web3.js'
import { STOCK_EXECUTION_ERRORS as E, MAINNET_GENESIS, STOCK_ABORT_MARGIN_BLOCKS, STOCK_FINALITY_MAX_MS, StockExecutionError,
  assertExecutionNetwork, followLanding, stockExecutionFlags } from '../src/stock-execution.mjs'
import { STOCK_COLLECTION_MIN_RAW, collectionTransactionInstructions, createStockCollectionExecutor,
  settledCollectionSplit } from '../src/stock-collection-execution.mjs'
import { STOCK_COLLECTION_SOURCES } from '../src/stock-collections.mjs'
import { STOCK_KEYCHAIN_SERVICES, keychainSigner, keychainSigners } from '../src/stock-keychain.mjs'
import { STOCK_LAUNCHER_PAYOUT_MIN_RAW, checkLauncherPayoutReceipt, createStockLauncherPayouts, custodyGate, launcherPayoutInstructions,
  launcherPayoutMinimum } from '../src/stock-launcher-payouts.mjs'
import { createStockExecutionJob, runStockExecution, stockExecutionLoud } from '../src/stock-execution-job.mjs'
import { dammCheckpoint } from '../src/stock-fee-policy.mjs'
import { ACCOUNT_RENT, META, address, collectionTransaction, curvePreview, curveReceipt, dammPreview, fakeChain, finalizedTransaction,
  loadFrom, payoutTransaction, previewOf, stockMarket, usableMint } from './fixtures/stock-execution-fakes.mjs'

// The execution state machine of stock-pair fee collections and launcher payouts (docs/STOCK_QUOTES.md, "Execution (off by
// default)") on an in-process chain and an in-memory store with the database's one-pending rules. tests/stock-execution-db.test.mjs
// runs the same machine on PostgreSQL, tests/stock-execution-chain.test.mjs on mainnet's programs.

const ON = { STOCK_COLLECTIONS_EXECUTION_ENABLED: 'true', STOCK_LAUNCHER_PAYOUTS_ENABLED: 'true' }
const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// The store's contract (src/stock-execution-store.mjs) in memory: one pending row per market and source (collections) or per
// market (payouts), updates only from pending, and a per-market lock that makes a second holder wait its turn (`held` names the
// markets whose lock is held right now).
function memoryStore({ custody = { collected: 0n, spent: 0n }, ahead = false } = {}) {
  const rows = { collection: new Map(), payout: new Map() }, queues = new Map(), alerts = [], held = new Set()
  let next = 0
  const db = { query: async (sql, params) => {
    if (/graduation_alerts/.test(sql)) alerts.push({ key: params[0], kind: params[2], detail: JSON.parse(params[3]) })
    return { rows: [], rowCount: 1 }
  } }
  const clone = row => (row ? structuredClone(row) : null)
  const pending = (kind, repoId) => [...rows[kind].values()].filter(r => r.status === 'pending' && (repoId == null || r.repoId === String(repoId)))
  const insert = (kind, row, clash) => {
    if (pending(kind, row.repoId).some(clash)) throw new StockExecutionError(E.IN_FLIGHT, `A ${kind} is already in flight`)
    const stored = { ...clone(row), id: String(++next), status: 'pending', settledAt: null }
    rows[kind].set(stored.id, stored)
    return clone(stored)
  }
  const update = (kind, id, change) => {
    const row = rows[kind].get(String(id))
    if (row?.status !== 'pending') return null
    rows[kind].set(row.id, { ...row, ...clone(change) })
    return clone(rows[kind].get(row.id))
  }
  return { rows, alerts, held,
    withLock: (repoId, work) => {
      const key = String(repoId)
      const turn = (queues.get(key) ?? Promise.resolve()).then(async () => { held.add(key); try { return await work(db) } finally { held.delete(key) } })
      queues.set(key, turn.catch(() => {}))
      return turn
    },
    insertCollection: async (_db, row) => insert('collection', row, r => r.source === row.source),
    pendingCollections: async (_db, { repoId } = {}) => pending('collection', repoId).map(clone),
    collection: async (_db, id) => clone(rows.collection.get(String(id))),
    settleCollection: async (_db, change) => update('collection', change.id, { ...change, status: 'settled', settledAt: 'now' }),
    abortCollection: async (_db, { id, receipt }) => update('collection', id, { status: 'aborted', receipt }),
    insertPayout: async (_db, row) => insert('payout', row, () => true),
    pendingPayouts: async (_db, { repoId } = {}) => pending('payout', repoId).map(clone),
    payout: async (_db, id) => clone(rows.payout.get(String(id))),
    settlePayout: async (_db, { id, receipt }) => update('payout', id, { status: 'settled', receipt, settledAt: 'now' }),
    abortPayout: async (_db, { id, receipt }) => update('payout', id, { status: 'aborted', receipt }),
    pendingMarkets: async (kind, { repoId } = {}) => [...new Set(pending(kind, repoId).map(r => r.repoId))],
    collectedAheadOfCheckpoints: async () => ahead,
    custodyLedger: async () => {
      const sum = (kind, status, field) => [...rows[kind].values()].filter(r => r.status === status).reduce((t, r) => t + BigInt(r[field]), 0n)
      return { collected: custody.collected + sum('collection', 'settled', 'actualAmount'), paid: sum('payout', 'settled', 'amount'),
        pending: sum('payout', 'pending', 'amount'), spent: custody.spent }
    },
  }
}

const crashing = state => ({ afterIntent: async () => { if (state.crash) { state.crash = false; throw Error('crash after the intent was stored') } } })

async function collectionSetup({ source = 'dbc_creator', crash = false, env = ON, receipt = null, verification = null, sources = undefined,
  hooksFor = null, followFor = null } = {}) {
  const creator = Keypair.generate(), partner = Keypair.generate(), custody = partner.publicKey.toBase58()
  const market = stockMarket({ creatorWallet: creator.publicKey.toBase58() })
  const signer = source.endsWith('creator') ? creator : partner
  const previewed = await curvePreview({ market, source, signer: signer.publicKey.toBase58(), custody })
  const store = memoryStore(), loads = [], state = { crash, preview: previewOf(market, [previewed]) }
  // A collection lands as a correct claim of its reviewed amount: the pool's vault −amount, custody +amount.
  const termsOf = signature => [...store.rows.collection.values()].find(row => row.signature === signature)?.receipt.terms
  const chain = fakeChain({ finalized: (raw, signature) => (termsOf(signature) ? collectionTransaction(raw, termsOf(signature)) : finalizedTransaction(raw)) })
  const executor = createStockCollectionExecutor({ pool: null, connection: chain.connection, verification, config: null, env, custody, partner: custody,
    store, previewMarket: async () => state.preview, listMarkets: async () => [market],
    checkReceipt: receipt ?? (({ terms, signature }) => curveReceipt(terms, signature)), loadTransaction: loadFrom,
    loadSigner: role => { loads.push(role); return role === 'creator' ? creator : partner }, mintCheck: async () => ({ ok: true }),
    follow: followFor ? followFor(chain, store) : chain.follow, hooks: hooksFor ? hooksFor(store) : crashing(state), ...(sources ? { sources } : {}) })
  const request = { repoId: market.repoId, source, termsHash: previewed.termsHash }
  return { chain, store, loads, market, previewed, executor, state, request, creator, partner, custody }
}

async function payoutSetup({ collected = 5_000_000n, crash = false, env = ON, minimum = undefined, market = stockMarket(), partner = Keypair.generate(),
  store = memoryStore({ custody: { collected: collected * 3n, spent: 0n } }), chain = null, ledgerPatch = {} } = {}) {
  const custody = partner.publicKey.toBase58(), loads = [], state = { crash }
  const termsOf = signature => [...store.rows.payout.values()].find(row => row.signature === signature)?.receipt.terms
  // A payout lands as a correct transfer; anything else sent on this chain lands as the chain already lands it.
  chain ??= fakeChain()
  const otherwise = chain.finalized
  chain.finalized = (raw, signature) => (termsOf(signature) ? payoutTransaction(raw, termsOf(signature)) : otherwise(raw, signature))
  // PR-D's ledger row for the market, from the store's payouts: collected is fixed, paid and pending follow the rows.
  const ledger = async (_db, repoId) => {
    const own = [...store.rows.payout.values()].filter(row => row.repoId === String(repoId))
    const sum = status => own.filter(row => row.status === status).reduce((total, row) => total + BigInt(row.amount), 0n)
    return { repoId: String(repoId), mint: market.mint, symbol: 'DOCUSAURUS', launcherWallet: market.launcherWallet, assetId: META.assetId,
      quoteMint: META.mint, curveEarned: String(collected + 777n), graduatedEarned: '0', curveAccumulated: '1', graduatedAccumulated: '0',
      collected: String(collected), paid: String(sum('settled')), pending: String(sum('pending')), ...ledgerPatch }
  }
  const payouts = createStockLauncherPayouts({ pool: null, connection: chain.connection, env, custody, store, listMarkets: async () => [market], ledger,
    loadTransaction: loadFrom, loadSigner: role => { loads.push(role); return partner }, mintCheck: usableMint, follow: chain.follow,
    custodyBalance: async () => chain.custodyBalance, hooks: crashing(state), ...(minimum === undefined ? {} : { minimum: () => minimum }) })
  return { chain, store, loads, market, payouts, state, partner, custody }
}

test('flags off: the worker job does not exist, reads no key and touches nothing; every execution entry point refuses first', async () => {
  const reads = []
  const env = new Proxy({}, { get: (_, name) => { reads.push(String(name)); return undefined } })
  const untouchable = new Proxy({}, { get: (_, name) => { throw Error(`touched ${String(name)}`) } })
  const connect = () => { throw Error('no connection may be made') }
  assert.equal(createStockExecutionJob({ pool: untouchable, connect, config: 'unused', env }), null)
  assert.deepEqual(reads.sort(), ['STOCK_COLLECTIONS_EXECUTION_ENABLED', 'STOCK_LAUNCHER_PAYOUTS_ENABLED'])
  // Only exactly 'true' turns a kind on.
  for (const value of ['TRUE', '1', 'yes', ' true', '']) {
    assert.deepEqual(stockExecutionFlags({ STOCK_COLLECTIONS_EXECUTION_ENABLED: value, STOCK_LAUNCHER_PAYOUTS_ENABLED: value }), { collections: false, payouts: false })
  }
  const loads = []
  const loadSigner = role => { loads.push(role); throw Error('no key may be loaded') }
  const collections = createStockCollectionExecutor({ pool: untouchable, connection: untouchable, config: 'unused', env, store: untouchable, loadSigner })
  const payouts = createStockLauncherPayouts({ pool: untouchable, connection: untouchable, env, store: untouchable, loadSigner })
  await assert.rejects(collections.collect({ repoId: '94911145', source: 'dbc_creator', termsHash: 'a'.repeat(64) }), { code: E.DISABLED })
  await assert.rejects(collections.recover(), { code: E.DISABLED })
  await assert.rejects(payouts.pay({ repoId: '94911145' }), { code: E.DISABLED })
  await assert.rejects(payouts.recover(), { code: E.DISABLED })
  assert.deepEqual(loads, [])
  assert.ok(!reads.some(name => /SECRET|KEY/.test(name)), 'no key variable was read')
  // One kind on builds only that kind.
  const only = createStockExecutionJob({ pool: untouchable, connect: () => ({ connection: untouchable }), config: 'unused', env: { STOCK_LAUNCHER_PAYOUTS_ENABLED: 'true' } })
  assert.deepEqual(only.flags, { collections: false, payouts: true })
  // On, but without the operator script's signer (as the worker builds them): collections and payouts refuse before reading
  // anything, so the worker can only recover; and the worker's job refuses a signer outright.
  const keyless = { pool: untouchable, connection: untouchable, env: ON, store: untouchable }
  await assert.rejects(createStockCollectionExecutor({ ...keyless, config: 'unused' }).collect({ repoId: '94911145', source: 'dbc_creator',
    termsHash: 'a'.repeat(64) }), { code: E.KEY_MISSING })
  await assert.rejects(createStockLauncherPayouts(keyless).pay({ repoId: '94911145' }), { code: E.KEY_MISSING })
  assert.throws(() => createStockExecutionJob({ pool: untouchable, connect: () => ({ connection: untouchable }), config: 'unused', env: ON,
    loadSigner: () => null }), /never signs/)
})

test('keys come only from the Keychain, read as the config script reads them, and a bad value never appears in an error', () => {
  const key = Keypair.generate(), calls = []
  const spawn = (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: `${bs58.encode(key.secretKey)}\n` } }
  assert.equal(keychainSigner('partner', { spawn, expected: key.publicKey.toBase58() }).publicKey.toBase58(), key.publicKey.toBase58())
  assert.deepEqual(calls, [['security', 'find-generic-password', '-s', 'repo.ing.dbc.partner', '-a', 'production', '-w']])
  assert.deepEqual(STOCK_KEYCHAIN_SERVICES, { partner: 'repo.ing.dbc.partner', creator: 'repo.ing.dbc.creator' })
  assert.throws(() => keychainSigner('partner', { spawn: () => ({ status: 44, stdout: '' }) }), { code: E.KEY_MISSING })
  const secret = 'not-a-key-but-secret-looking-value'
  assert.throws(() => keychainSigner('creator', { spawn: () => ({ status: 0, stdout: secret }) }), error => error.code === E.KEY_INVALID && !error.message.includes(secret))
  assert.throws(() => keychainSigner('partner', { spawn, expected: address() }), { code: E.SIGNER_MISMATCH })
  assert.throws(() => keychainSigner('owner', { spawn }), { code: E.INVALID_REQUEST })
  // Each role is read once per run.
  const reads = []
  const signers = keychainSigners({ spawn: (command, args) => { reads.push(args[2]); return { status: 0, stdout: bs58.encode(key.secretKey) } } })
  signers('creator'); signers('creator'); signers('partner')
  assert.deepEqual(reads, ['repo.ing.dbc.creator', 'repo.ing.dbc.partner'])
})

test('the worker path holds no key: nothing it loads reads one, and its job only finishes rows the script signed', async () => {
  for (const file of ['src/stock-execution-job.mjs', 'src/stock-collection-execution.mjs', 'src/stock-launcher-payouts.mjs', 'src/stock-execution.mjs',
    'src/stock-execution-store.mjs']) {
    assert.doesNotMatch(await readFile(file, 'utf8'), /SECRET_KEY|find-generic-password|from '\.\/stock-keychain\.mjs'|process\.env\.PLATFORM/, file)
  }
  const wiring = (await readFile('scripts/run-worker.mjs', 'utf8')).split('\n').filter(line => /stockExecution|StockExecution/.test(line)).join('\n')
  assert.doesNotMatch(wiring, /loadSigner|SECRET|Keychain|keychain/)
  // A collection the script signed and stored, then crashed before sending: the worker's job sends those stored bytes and settles
  // them, with no signer anywhere in it.
  const s = await collectionSetup({ crash: true })
  await assert.rejects(s.executor.collect(s.request), /crash/)
  const job = createStockExecutionJob({ pool: null, config: null, env: ON, connect: () => ({ connection: s.chain.connection }), store: s.store,
    previewMarket: async () => { throw Error('the worker never previews') }, listMarkets: async () => { throw Error('the worker never plans') },
    checkReceipt: ({ terms, signature }) => curveReceipt(terms, signature), loadTransaction: loadFrom, follow: s.chain.follow })
  assert.deepEqual((await job.runOnce()).collections.map(item => item.status), ['REBROADCAST'])
  const settled = await job.runOnce()
  assert.deepEqual([settled.collections.map(item => [item.status, item.amount]), settled.payouts], [[['SETTLED', s.previewed.amount]], []])
  assert.equal([...s.store.rows.collection.values()][0].status, 'settled')
  assert.deepEqual(s.loads, ['creator'], 'only the script loaded a key, before it crashed')
})

test('execution runs on mainnet with a second RPC that agrees, or on a local validator', async () => {
  const at = (endpoint, genesis) => ({ rpcEndpoint: endpoint, getGenesisHash: async () => genesis })
  assert.equal(await assertExecutionNetwork({ connection: at('http://127.0.0.1:8921', 'Local') }), 'Local')
  await assert.rejects(assertExecutionNetwork({ connection: at('https://rpc.example', 'Devnet') }), { code: E.NETWORK })
  await assert.rejects(assertExecutionNetwork({ connection: at('https://rpc.example', MAINNET_GENESIS) }), /independent verification RPC/)
  await assert.rejects(assertExecutionNetwork({ connection: at('https://rpc.example', MAINNET_GENESIS), verification: at('https://b.example', 'Devnet') }), /different networks/)
  assert.equal(await assertExecutionNetwork({ connection: at('https://rpc.example', MAINNET_GENESIS), verification: at('https://b.example', MAINNET_GENESIS) }), MAINNET_GENESIS)
})

test('a collection whose terms changed since review is refused before a key is loaded or anything is signed or stored', async () => {
  const s = await collectionSetup()
  await assert.rejects(s.executor.collect({ ...s.request, termsHash: 'f'.repeat(64) }), { code: E.TERMS_CHANGED })
  // Terms altered after they were hashed, or instructions other than the hashed ones.
  s.state.preview = previewOf(s.market, [{ ...s.previewed, terms: { ...s.previewed.terms, amount: '1' } }])
  await assert.rejects(s.executor.collect(s.request), { code: E.TERMS_CHANGED })
  s.state.preview = previewOf(s.market, [{ ...s.previewed, instructions: [...s.previewed.instructions].reverse() }])
  await assert.rejects(s.executor.collect(s.request), { code: E.TERMS_CHANGED })
  // A source that no longer matches is reported, not executed.
  s.state.preview = previewOf(s.market, [{ ...s.previewed, status: 'MISMATCH', reason: 'The pool holds fees the ledger has not recorded; indexing must catch up' }])
  assert.equal((await s.executor.collect(s.request)).status, 'NOT_COLLECTABLE')
  assert.deepEqual([s.loads, s.chain.sends, s.store.rows.collection.size], [[], [], 0])
  assert.ok(!s.chain.calls.includes('getLatestBlockhash'), 'nothing was signed')
})

test('a collection is stored pending with its signed bytes before it is sent, then settled from its finalized receipt', async () => {
  for (const source of ['dbc_creator', 'dbc_partner']) {
    const s = await collectionSetup({ source })
    const seen = []
    s.state.crash = false
    const executor = createStockCollectionExecutor({ pool: null, connection: s.chain.connection, config: null, env: ON, custody: s.custody, partner: s.custody,
      store: s.store, previewMarket: async () => s.state.preview, listMarkets: async () => [s.market], checkReceipt: ({ terms, signature }) => curveReceipt(terms, signature),
      loadTransaction: loadFrom, loadSigner: role => { s.loads.push(role); return role === 'creator' ? s.creator : s.partner }, mintCheck: async () => ({ ok: true }),
      follow: s.chain.follow, hooks: { afterIntent: row => seen.push({ row, sends: s.chain.sends.length }) } })
    const result = await executor.collect(s.request)
    assert.equal(result.status, 'SETTLED', result.reason)
    assert.deepEqual(s.loads, [source === 'dbc_creator' ? 'creator' : 'partner'], 'the key of that side, once')
    const [{ row, sends }] = seen
    assert.equal(sends, 0, 'recorded before anything was sent')
    assert.deepEqual([row.status, row.receipt.state, row.receipt.terms.amount], ['pending', 'pending', s.previewed.amount])
    assert.ok(Number(row.receipt.lastValidBlockHeight) > 0)
    assert.ok(s.chain.sends.length >= 1 && s.chain.sends.every(bytes => bytes === row.signedTransaction), 'only the stored bytes were sent')
    const settled = s.store.rows.collection.get(row.id)
    assert.deepEqual([settled.status, settled.actualAmount, settled.launcherAmount, settled.accumulatorAmount],
      ['settled', s.previewed.amount, s.previewed.launcherAmount, s.previewed.accumulatorAmount])
    assert.deepEqual([settled.receipt.state, settled.receipt.signature, settled.receipt.intent.lastValidBlockHeight], ['settled', row.signature, row.receipt.lastValidBlockHeight])
    // Settled: a second run finds nothing pending and recovery has nothing to do.
    assert.deepEqual(await executor.recover(), [])
  }
})

test('a collection that would land anywhere but the stock custody account, or report another amount than moved, is refused', async () => {
  // Custody configured as a wallet other than the fee claimer: the preview's account is not the custody account the reconciliation
  // and payouts use.
  const s = await collectionSetup()
  const elsewhere = createStockCollectionExecutor({ pool: null, connection: s.chain.connection, config: null, env: ON, custody: s.custody,
    partner: address(), store: s.store, previewMarket: async () => s.state.preview, listMarkets: async () => [s.market], loadTransaction: loadFrom,
    loadSigner: role => { s.loads.push(role); return s.creator }, mintCheck: async () => ({ ok: true }), follow: s.chain.follow })
  await assert.rejects(elsewhere.collect(s.request), /does not land in the stock custody account/)
  assert.deepEqual([s.loads, s.chain.sends], [[], []])
  // A claim that reports its amount while custody received less is held for review, never settled.
  const short = await collectionSetup()
  short.chain.finalized = raw => collectionTransaction(raw, short.previewed.terms, BigInt(short.previewed.amount) - 1n)
  const result = await short.executor.collect(short.request)
  assert.deepEqual([result.status, result.reason], ['REVIEW', 'What the pool released, what custody received and what the claim reports differ'])
})

test('a wrong key for the reviewed signer is refused before signing', async () => {
  const s = await collectionSetup()
  const other = Keypair.generate()
  const executor = createStockCollectionExecutor({ pool: null, connection: s.chain.connection, config: null, env: ON, custody: s.custody, partner: s.custody,
    store: s.store, previewMarket: async () => s.state.preview, listMarkets: async () => [s.market], loadTransaction: loadFrom,
    loadSigner: () => other, mintCheck: async () => ({ ok: true }), follow: s.chain.follow })
  await assert.rejects(executor.collect(s.request), { code: E.SIGNER_MISMATCH })
  assert.deepEqual([s.chain.sends, s.store.rows.collection.size], [[], 0])
})

test('a crash after the signed collection is stored: recovery rebroadcasts the same bytes while the blockhash is valid, then settles', async () => {
  const s = await collectionSetup({ crash: true })
  await assert.rejects(s.executor.collect(s.request), /crash after the intent was stored/)
  const [row] = s.store.rows.collection.values()
  assert.deepEqual([row.status, s.chain.sends.length], ['pending', 0])
  // While it is pending, a new collection of that source is refused before a key is loaded or anything is signed.
  await assert.rejects(s.executor.collect(s.request), { code: E.IN_FLIGHT })
  assert.equal(s.loads.length, 1)
  assert.equal((await s.executor.recover({ dryRun: true }))[0].status, 'WOULD_REBROADCAST')
  assert.equal(s.chain.sends.length, 0, 'a dry run sends nothing')
  s.chain.landing = 'none'
  assert.equal((await s.executor.recover())[0].status, 'REBROADCAST')
  s.chain.refuseSends = true
  const refused = (await s.executor.recover())[0]
  assert.deepEqual([refused.status, /Rebroadcast refused/.test(refused.reason)], ['WAITING', true])
  s.chain.refuseSends = false
  s.chain.landing = 'finalized'
  assert.equal((await s.executor.recover())[0].status, 'REBROADCAST')
  const settled = (await s.executor.recover())[0]
  assert.deepEqual([settled.status, settled.signature], ['SETTLED', row.signature])
  assert.ok(s.chain.sends.every(bytes => bytes === row.signedTransaction), 'every send was the stored transaction')
  assert.equal(s.store.rows.collection.get(row.id).status, 'settled')
})

test('an expired blockhash aborts a pending row only past the safety margin on the verification RPC, and only when no RPC knows it', async () => {
  const other = fakeChain()
  const s = await collectionSetup({ crash: true, verification: other.connection })
  await assert.rejects(s.executor.collect(s.request), /crash/)
  const [row] = s.store.rows.collection.values()
  const expiry = Number(row.receipt.lastValidBlockHeight), margin = Number(STOCK_ABORT_MARGIN_BLOCKS)
  // Expired at the primary: never sent again, but not aborted until the verification RPC is past the margin at finalized.
  s.chain.finalizedHeight = expiry + 1
  for (const height of [expiry, expiry + margin]) {
    other.finalizedHeight = height
    const waiting = (await s.executor.recover())[0]
    assert.deepEqual([waiting.status, /safety margin/.test(waiting.reason)], ['WAITING', true])
  }
  other.finalizedHeight = expiry + margin + 1
  // Known to the primary, or only to the verification RPC: it may still land, so it waits.
  s.chain.known.add(row.signature)
  assert.equal((await s.executor.recover())[0].status, 'WAITING')
  s.chain.known.delete(row.signature)
  other.known.add(row.signature)
  assert.equal((await s.executor.recover())[0].status, 'WAITING')
  other.known.delete(row.signature)
  assert.equal((await s.executor.recover({ dryRun: true }))[0].status, 'WOULD_ABORT')
  assert.equal(s.store.rows.collection.get(row.id).status, 'pending')
  const aborted = (await s.executor.recover())[0]
  assert.equal(aborted.status, 'ABORTED')
  const stored = s.store.rows.collection.get(row.id)
  assert.deepEqual([stored.status, stored.receipt.state, stored.receipt.intent.blockhash], ['aborted', 'aborted', row.receipt.blockhash])
  assert.deepEqual(s.chain.sends, [], 'an expired transaction is never sent again')
  // The source can be collected again afterwards.
  s.chain.finalizedHeight = s.chain.height
  assert.equal((await s.executor.collect(s.request)).status, 'SETTLED')
})

test('a collection that finalized with an error aborts; one that landed with a mismatched receipt stays pending for review', async () => {
  const failing = await collectionSetup()
  failing.chain.finalized = raw => finalizedTransaction(raw, { err: { InstructionError: [2, { Custom: 6000 }] } })
  const failed = await failing.executor.collect(failing.request)
  assert.deepEqual([failed.status, failed.reason], ['ABORTED', 'The finalized transaction failed on chain'])
  const mismatched = await collectionSetup({ receipt: () => { throw Error('Exact balance delta mismatch on the custody account') } })
  const review = await mismatched.executor.collect(mismatched.request)
  assert.equal(review.status, 'REVIEW')
  const [row] = mismatched.store.rows.collection.values()
  assert.equal(row.status, 'pending')
  assert.deepEqual(mismatched.store.alerts.map(a => [a.kind, a.detail.code]), [['STOCK_EXECUTION_REVIEW', E.RECEIPT]])
  // Even after its blockhash expires, a landed transaction is never aborted.
  mismatched.chain.finalizedHeight = Number(row.receipt.lastValidBlockHeight) + 1000 + Number(STOCK_ABORT_MARGIN_BLOCKS)
  assert.equal((await mismatched.executor.recover())[0].status, 'REVIEW')
  assert.equal(mismatched.store.rows.collection.get(row.id).status, 'pending')
})

test('payouts: below the minimum nothing is loaded, signed or sent; at the minimum the launcher is paid', async () => {
  assert.equal(launcherPayoutMinimum('meta-xstock'), STOCK_LAUNCHER_PAYOUT_MIN_RAW)
  assert.equal(launcherPayoutMinimum('nvda-xstock', { 'nvda-xstock': '2000000' }), 2_000_000n)
  const below = await payoutSetup({ collected: STOCK_LAUNCHER_PAYOUT_MIN_RAW - 1n })
  const decision = await below.payouts.pay({ repoId: below.market.repoId })
  assert.deepEqual([decision.status, decision.payable, decision.minimum], ['BELOW_MINIMUM', '999999', '1000000'])
  assert.deepEqual([below.loads, below.chain.sends, below.store.rows.payout.size], [[], [], 0])
  assert.ok(!below.chain.calls.includes('getLatestBlockhash'))
  const nothing = await payoutSetup({ collected: 0n })
  assert.equal((await nothing.payouts.pay({ repoId: nothing.market.repoId })).status, 'NOTHING')
  const at = await payoutSetup({ collected: STOCK_LAUNCHER_PAYOUT_MIN_RAW })
  const paid = await at.payouts.pay({ repoId: at.market.repoId })
  assert.deepEqual([paid.status, paid.amount, paid.accountCreated], ['SETTLED', '1000000', true])
  assert.deepEqual(at.loads, ['partner'])
})

test('payouts: a double run never pays twice, also across a crash and when two runs start at once', async () => {
  const s = await payoutSetup()
  // Two runs at once: the market's lock makes the second wait until the first has recorded and sent its payout, which it then
  // finds in flight; it signs nothing.
  const [first, concurrent] = await Promise.all([s.payouts.pay({ repoId: s.market.repoId }), s.payouts.pay({ repoId: s.market.repoId })])
  assert.deepEqual([first.status, concurrent.status], ['SETTLED', 'IN_FLIGHT'])
  assert.deepEqual(s.loads, ['partner'])
  assert.equal(first.amount, '5000000')
  assert.equal((await s.payouts.pay({ repoId: s.market.repoId })).status, 'NOTHING')
  assert.equal(s.chain.sends.length, 1)
  const [row] = s.store.rows.payout.values()
  assert.deepEqual([row.status, row.wallet, row.amount, row.receipt.state, row.receipt.amount, row.receipt.terms],
    ['settled', s.market.launcherWallet, '5000000', 'settled', '5000000', undefined])

  const c = await payoutSetup({ crash: true })
  await assert.rejects(c.payouts.pay({ repoId: c.market.repoId }), /crash/)
  const [pending] = c.store.rows.payout.values()
  assert.deepEqual([pending.status, c.chain.sends.length], ['pending', 0])
  const again = await c.payouts.pay({ repoId: c.market.repoId })
  assert.deepEqual([again.status, again.pending], ['IN_FLIGHT', '5000000'], 'a pending payout is never paid again')
  assert.deepEqual(c.loads, ['partner'], 'no key loaded for the refused run')
  assert.equal((await c.payouts.recover())[0].status, 'REBROADCAST')
  assert.equal((await c.payouts.recover())[0].status, 'SETTLED')
  assert.equal((await c.payouts.pay({ repoId: c.market.repoId })).status, 'NOTHING')
  assert.deepEqual(c.chain.sends, [pending.signedTransaction], 'one transaction, sent once')
  assert.equal(c.store.rows.payout.size, 1)
})

test('payouts: an expired unsent payout aborts and the amount becomes payable again', async () => {
  const s = await payoutSetup({ crash: true })
  await assert.rejects(s.payouts.pay({ repoId: s.market.repoId }), /crash/)
  const [row] = s.store.rows.payout.values()
  assert.deepEqual(row.receipt.terms.custodyCheck, { balance: '50000000', holds: '15000000', needed: '5000000' })
  assert.equal(row.receipt.terms.rentCap, String(ACCOUNT_RENT), "the rent of the launcher's account, for this mint")
  // Without a verification RPC (a local validator) the primary decides, with the same margin.
  s.chain.finalizedHeight = Number(row.receipt.lastValidBlockHeight) + Number(STOCK_ABORT_MARGIN_BLOCKS)
  assert.equal((await s.payouts.recover())[0].status, 'WAITING')
  s.chain.finalizedHeight += 1
  assert.equal((await s.payouts.recover())[0].status, 'ABORTED')
  s.chain.finalizedHeight = s.chain.height
  assert.equal((await s.payouts.pay({ repoId: s.market.repoId })).status, 'SETTLED')
  assert.deepEqual([...s.store.rows.payout.values()].map(p => p.status), ['aborted', 'settled'])
})

test('custody: a shortfall against the ledgers blocks payouts loudly; a surplus never does; pending payouts must stay covered', async () => {
  // The rule itself: never an equality, a lower bound that counts pending payouts as possibly gone already.
  const ledger = { collected: 10_000_000n, paid: 1_000_000n, pending: 2_000_000n, spent: 3_000_000n }
  assert.deepEqual(custodyGate({ balance: 7_000_000n, amount: 5_000_000n, ledger }), { ok: true, balance: 7_000_000n, holds: 4_000_000n, needed: 7_000_000n })
  assert.equal(custodyGate({ balance: 6_999_999n, amount: 5_000_000n, ledger }).ok, false)
  assert.equal(custodyGate({ balance: 9_999_999_999n, amount: 5_000_000n, ledger }).ok, true, 'dust or any surplus is fine')
  assert.throws(() => custodyGate({ balance: 3_999_999n, amount: 1n, ledger }), { code: E.CUSTODY_SHORTFALL })
  assert.throws(() => custodyGate({ balance: 10n ** 12n, amount: 1n, ledger: { ...ledger, paid: 10n ** 9n } }), /inconsistent/)

  // Another market of the same stock has a payout in flight: this one waits until custody covers both, with no key loaded.
  const s = await payoutSetup({ store: memoryStore({ custody: { collected: 6_000_000n, spent: 0n } }) })
  await s.store.insertPayout(null, { repoId: '41881900', assetId: META.assetId, quoteMint: META.mint, wallet: address(), amount: '2000000',
    signature: 'other', signedTransaction: 'other', receipt: {} })
  s.chain.custodyBalance = 6_999_999n
  const waiting = await s.payouts.pay({ repoId: s.market.repoId })
  assert.deepEqual([waiting.status, waiting.custodyNeeded], ['WAITING', '7000000'])
  assert.equal((await s.payouts.plan(s.market)).status, 'WAITING', 'a dry run says so too')
  // Below what the ledgers say custody holds (collected 6000000 − pending 2000000): every payout of the stock is an ERROR.
  s.chain.custodyBalance = 3_999_999n
  await assert.rejects(s.payouts.pay({ repoId: s.market.repoId }), { code: E.CUSTODY_SHORTFALL })
  await assert.rejects(s.payouts.plan(s.market), { code: E.CUSTODY_SHORTFALL })
  const pass = await runStockExecution({ payouts: s.payouts, listMarkets: async () => [s.market], execute: true })
  // Both loud: the other market's pending row (made by hand here, with no intent) cannot be recovered, and the shortfall.
  assert.deepEqual(pass.payouts.map(i => [i.repoId, i.status, i.code]), [['41881900', 'ERROR', E.INTENT], [s.market.repoId, 'ERROR', E.CUSTODY_SHORTFALL]])
  assert.deepEqual([s.loads, s.chain.sends], [[], []])
  // Covered, with dust on top: paid.
  s.chain.custodyBalance = 7_000_123n
  assert.equal((await s.payouts.pay({ repoId: s.market.repoId })).status, 'SETTLED')
  assert.deepEqual(s.loads, ['partner'])
})

test('the payout receipt is exactly one transfer of the amount to the launcher; any other movement is refused', () => {
  const custody = Keypair.generate(), wallet = address()
  const built = launcherPayoutInstructions({ custody: custody.publicKey.toBase58(), wallet, mint: META.mint, decimals: META.decimals, amount: 5_000_000n })
  const tx = new Transaction({ feePayer: custody.publicKey, recentBlockhash: address() }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), ...built.instructions)
  tx.sign(custody)
  const raw = tx.serialize(), signature = bs58.encode(tx.signature)
  const terms = { quoteMint: META.mint, decimals: META.decimals, wallet, walletTokenAccount: built.walletTokenAccount, custody: custody.publicKey.toBase58(),
    custodyTokenAccount: built.custodyTokenAccount, amount: '5000000', rentCap: String(ACCOUNT_RENT) }
  const good = payoutTransaction(raw, terms)
  const receipt = checkLauncherPayoutReceipt({ transaction: good, terms, signature })
  assert.deepEqual([receipt.amount, receipt.accountCreated, receipt.rent, receipt.networkFee], ['5000000', true, String(ACCOUNT_RENT), '25000'])
  const existing = checkLauncherPayoutReceipt({ transaction: payoutTransaction(raw, terms, { created: false }), terms, signature })
  assert.deepEqual([existing.accountCreated, existing.rent], [false, '0'])
  // Anyone can send lamports to the launcher's account address before it exists. The account program then takes only the rest of
  // the rent from custody: the payout still settles, with custody paying exactly the fee and what the account gained.
  const prefunded = checkLauncherPayoutReceipt({ transaction: payoutTransaction(raw, terms, { prefunded: 890_880 }), terms, signature })
  assert.deepEqual([prefunded.accountCreated, prefunded.rent], [true, String(ACCOUNT_RENT - 890_880)])
  const fullyPrefunded = checkLauncherPayoutReceipt({ transaction: payoutTransaction(raw, terms, { prefunded: ACCOUNT_RENT }), terms, signature })
  assert.deepEqual([fullyPrefunded.accountCreated, fullyPrefunded.rent], [true, '0'])
  const refused = (transaction, pattern, changed = terms) => assert.throws(() => checkLauncherPayoutReceipt({ transaction, terms: changed, signature }), pattern)
  refused(null, /not available yet/)
  refused({ ...good, meta: { ...good.meta, err: { InstructionError: [3, 'Custom'] } } }, /failed on chain/)
  refused(good, /not the reviewed one/, { ...terms, amount: '5000001' })
  refused(good, /signed and paid for by custody alone/, { ...terms, custody: address() })
  // The launcher's account may gain at most its rent, and may never lose SOL; custody pays exactly the fee and that gain.
  refused(payoutTransaction(raw, terms, { rent: ACCOUNT_RENT + 1 }), /gained more than its rent/)
  const keysOf = transaction => transaction.transaction.message.accountKeys.map(k => k.toBase58())
  const walletAt = keysOf(good).indexOf(built.walletTokenAccount)
  const drained = payoutTransaction(raw, terms, { created: false })
  refused({ ...drained, meta: { ...drained.meta, postBalances: drained.meta.postBalances.map((v, i) => (i === walletAt ? v - 1 : i === 0 ? v + 1 : v)) } }, /or lost SOL/)
  refused({ ...good, meta: { ...good.meta, postBalances: good.meta.postBalances.map((v, i) => (i === 0 ? v - 1 : v)) } }, /Unexpected SOL movement/)
  const keys = good.transaction.message.accountKeys
  const owner = keys.findIndex(k => k.toBase58() === wallet)
  refused({ ...good, meta: { ...good.meta, postBalances: good.meta.postBalances.map((v, i) => (i === owner ? v + 1 : v)) } }, /Unexpected SOL movement/)
  refused({ ...good, meta: { ...good.meta, innerInstructions: [{ index: 3, instructions: [] }] } }, /Another program ran under the transfer/)
  const extra = { ...good.meta.postTokenBalances[0], mint: address() }
  refused({ ...good, meta: { ...good.meta, postTokenBalances: [...good.meta.postTokenBalances, extra] } }, /Another token moved/)
  const short = good.meta.postTokenBalances.map(b => (b.accountIndex === keys.findIndex(k => k.toBase58() === built.walletTokenAccount)
    ? { ...b, uiTokenAmount: { ...b.uiTokenAmount, amount: '4999999' } } : b))
  refused({ ...good, meta: { ...good.meta, postTokenBalances: short } }, /balance delta mismatch/)
  assert.throws(() => checkLauncherPayoutReceipt({ transaction: good, terms, signature: bs58.encode(Buffer.alloc(64, 7)) }), /signature mismatch/)
})

test('a curve collection settles exactly its review; a graduated position\'s excess is split as the next DAMM checkpoint credits it', () => {
  const terms = (source, { amount, launcher, earned = amount, collected = '0' }) => ({ source, amount, launcherAmount: launcher,
    accumulatorAmount: String(BigInt(amount) - BigInt(launcher)), ledger: { earned, collected } })
  assert.deepEqual(settledCollectionSplit(terms('dbc_creator', { amount: '1000', launcher: '301' }), '1000'), { launcherAmount: 301n, accumulatorAmount: 699n })
  assert.throws(() => settledCollectionSplit(terms('dbc_creator', { amount: '1000', launcher: '301' }), '1001'), /curve claim received more/)
  assert.throws(() => settledCollectionSplit(terms('damm_creator', { amount: '1000', launcher: '301' }), '999'), /less than its review/)
  assert.throws(() => settledCollectionSplit({ ...terms('dbc_partner', { amount: '1000', launcher: '0' }), accumulatorAmount: '999' }, '1000'), /do not add up/)
  assert.deepEqual(settledCollectionSplit(terms('damm_partner', { amount: '400', launcher: '0' }), '450'), { launcherAmount: 0n, accumulatorAmount: 450n })
  // Creator side: the launcher's parts across collections always equal the checkpoint rule's running total.
  for (const [earned, collectedBefore, excess] of [[1_000_000n, 0n, 10_000n], [7_777_777n, 3_000_000n, 1n], [497n, 0n, 496n], [10n ** 15n, 10n ** 14n, 123_456_789n]]) {
    const launcherBefore = dammCheckpoint({ side: 'creator', cumulativeEarned: collectedBefore }).launcherCumulative
    const launcherNow = dammCheckpoint({ side: 'creator', cumulativeEarned: earned }).launcherCumulative
    const reviewed = earned - collectedBefore
    const split = settledCollectionSplit(terms('damm_creator', { amount: String(reviewed), launcher: String(launcherNow - launcherBefore),
      earned: String(earned), collected: String(collectedBefore) }), String(reviewed + excess))
    assert.equal(split.launcherAmount + split.accumulatorAmount, reviewed + excess)
    assert.equal(launcherBefore + split.launcherAmount, dammCheckpoint({ side: 'creator', cumulativeEarned: earned + excess }).launcherCumulative)
  }
})

test('only a collection\'s exact shape executes: the hashed instructions, the custody\'s own accounts, the reviewed signer alone', async () => {
  const s = await collectionSetup()
  assert.equal(collectionTransactionInstructions(s.previewed).length, 3)
  const rehashed = instructions => ({ ...s.previewed, instructions, terms: { ...s.previewed.terms, instructionsSha256: sha256(instructions) } })
  const forSomeoneElse = structuredClone(s.previewed.instructions)
  forSomeoneElse[1].accounts[2].address = address()
  assert.throws(() => collectionTransactionInstructions(rehashed(forSomeoneElse)), /only the custody's own token accounts/)
  const cosigned = structuredClone(s.previewed.instructions)
  cosigned[2].accounts[0] = { ...cosigned[2].accounts[0], signer: true }
  assert.throws(() => collectionTransactionInstructions(rehashed(cosigned)), /Only the reviewed signer/)
  assert.throws(() => collectionTransactionInstructions(rehashed(s.previewed.instructions.slice(1))), /two idempotent token accounts and one claim/)
  const otherProgram = structuredClone(s.previewed.instructions)
  otherProgram[2].program = address()
  assert.throws(() => collectionTransactionInstructions(rehashed(otherProgram)), /two idempotent token accounts and one claim/)
})

test('a pass: a dry run plans without a key or a send; executing collects, then pays, and a second pass does nothing', async () => {
  const c = await collectionSetup()
  // One market, one store, one chain for both kinds, as in the worker.
  const p = await payoutSetup({ market: c.market, partner: c.partner, store: c.store, chain: c.chain })
  const pass = execute => runStockExecution({ collections: c.executor, payouts: p.payouts, listMarkets: async () => [c.market], execute })
  const plan = await pass(false)
  assert.deepEqual(plan.collections.map(i => [i.source, i.status, i.termsHash]), [['dbc_creator', 'WOULD_COLLECT', c.previewed.termsHash]])
  assert.deepEqual(plan.payouts.map(i => [i.status, i.amount]), [['WOULD_PAY', '5000000']])
  assert.deepEqual([c.loads, p.loads, c.chain.sends, c.store.rows.collection.size, c.store.rows.payout.size], [[], [], [], 0, 0])
  const done = await pass(true)
  assert.deepEqual(done.collections.map(i => [i.kind, i.source, i.status]), [['collection', 'dbc_creator', 'SETTLED']])
  assert.deepEqual(done.payouts.map(i => [i.kind, i.status, i.amount]), [['payout', 'SETTLED', '5000000']])
  // What a real preview says after the collection: nothing left. The payout finds nothing payable: the pass is empty.
  c.state.preview = previewOf(c.market, [{ ...c.previewed, status: 'EMPTY', reason: 'Nothing to collect' }])
  assert.deepEqual(await pass(true), { collections: [], payouts: [] })
  assert.equal(c.chain.sends.length, 2)
  // A preview that cannot be read is loud.
  c.state.preview = { status: 'UNREADABLE', error: 'RPC disagreement; refresh before collection', sources: [] }
  const loud = await runStockExecution({ collections: c.executor, listMarkets: async () => [c.market], execute: true })
  assert.deepEqual(loud.collections.map(i => i.status), ['ERROR'])
})

test('a graduated position\'s claim that lands with more than its review settles the excess by the checkpoint rule', async () => {
  const creator = Keypair.generate(), partner = Keypair.generate(), custody = partner.publicKey.toBase58()
  const market = stockMarket({ creatorWallet: creator.publicKey.toBase58(), dammPool: address() })
  const earned = 20_000_000n, excess = 12_345n
  const previewed = await dammPreview({ market, signer: creator.publicKey.toBase58(), custody, earned })
  assert.equal(collectionTransactionInstructions(previewed).length, 3, 'a position claim has the collection shape too')
  const store = memoryStore()
  const termsOf = signature => [...store.rows.collection.values()].find(row => row.signature === signature).receipt.terms
  // The position kept earning between the preview and the claim: the program paid everything accrued, the review plus the excess,
  // out of the pool's vault into custody.
  const chain = fakeChain({ finalized: (raw, signature) => collectionTransaction(raw, termsOf(signature), BigInt(termsOf(signature).amount) + excess) })
  const raced = ({ terms, signature }) => ({ ...curveReceipt(terms, signature), amount: String(BigInt(terms.amount) + excess), excess: String(excess) })
  const executor = createStockCollectionExecutor({ pool: null, connection: chain.connection, config: null, env: ON, custody, partner: custody, store,
    previewMarket: async () => previewOf(market, [previewed]), listMarkets: async () => [market], checkReceipt: raced, loadTransaction: loadFrom,
    loadSigner: () => creator, mintCheck: async () => ({ ok: true }), follow: chain.follow, sources: STOCK_COLLECTION_SOURCES })
  const settled = await executor.collect({ repoId: market.repoId, source: 'damm_creator', termsHash: previewed.termsHash })
  assert.equal(settled.status, 'SETTLED', settled.reason)
  const [row] = store.rows.collection.values()
  const launcher = dammCheckpoint({ side: 'creator', cumulativeEarned: earned + excess }).launcherCumulative
  assert.deepEqual([row.actualAmount, row.launcherAmount, row.accumulatorAmount], [String(earned + excess), String(launcher), String(earned + excess - launcher)])
  assert.equal(BigInt(row.launcherAmount) + BigInt(row.accumulatorAmount), BigInt(row.actualAmount), 'the parts add up to what custody received')
  assert.equal(row.receipt.excess, String(excess))
  // A curve claim never takes more than its review: the same receipt on a curve source is held for review, never settled.
  const curve = await collectionSetup({ receipt: raced })
  assert.equal((await curve.executor.collect(curve.request)).status, 'REVIEW')
})

test('payouts wait while a graduated-pool collection is ahead of the DAMM checkpoints; otherwise collected > earned is a review', async () => {
  // PR-D's ledger refuses a launcher who collected more than they earned. Right after a raced position claim that is expected:
  // the next checkpoint credits the excess.
  const patch = { curveEarned: '0', graduatedEarned: '4000000', collected: '5000000' }
  const waiting = await payoutSetup({ ledgerPatch: patch, store: memoryStore({ custody: { collected: 15_000_000n, spent: 0n }, ahead: true }) })
  const decision = await waiting.payouts.pay({ repoId: waiting.market.repoId })
  assert.deepEqual([decision.status, /DAMM checkpoints/.test(decision.reason)], ['WAITING', true])
  const review = await payoutSetup({ ledgerPatch: patch, store: memoryStore({ custody: { collected: 15_000_000n, spent: 0n }, ahead: false }) })
  const pass = await runStockExecution({ payouts: review.payouts, listMarkets: async () => [review.market], execute: true })
  assert.deepEqual(pass.payouts.map(item => [item.status, item.reason]), [['REVIEW', 'Launcher collections exceed launcher earnings']])
  assert.deepEqual([waiting.loads, review.loads, waiting.chain.sends, review.chain.sends], [[], [], [], []])
})

test('the market lock is held to sign, record and send, and released while the transaction is followed to finality', async () => {
  const seen = { recorded: null, following: [] }
  const s = await collectionSetup({ hooksFor: store => ({ afterIntent: async row => { seen.recorded = store.held.has(String(row.repoId)) } }),
    followFor: (chain, store) => ({ now: chain.follow.now, sleep: async ms => { seen.following.push(store.held.has('94911145')); await chain.follow.sleep(ms) } }) })
  assert.equal((await s.executor.collect(s.request)).status, 'SETTLED')
  assert.equal(seen.recorded, true, 'the pending row is recorded under the lock')
  assert.ok(seen.following.length > 0 && seen.following.every(held => held === false), 'the lock is free while it lands')
  // Following is bounded: a transaction that lands but never finalizes is left to recovery after at most STOCK_FINALITY_MAX_MS.
  const chain = fakeChain(), payer = Keypair.generate()
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: address() }).add(SystemProgram.transfer({ fromPubkey: payer.publicKey,
    toPubkey: payer.publicKey, lamports: 1 }))
  tx.sign(payer)
  chain.landing = 'known'
  const followed = await followLanding({ connection: chain.connection, landing: { raw: tx.serialize(), signature: bs58.encode(tx.signature),
    lastValidBlockHeight: 10n ** 9n }, ...chain.follow, finalityMs: 10 * 60_000 })
  assert.deepEqual(followed, { state: 'unsettled', reason: 'not finalized in time' })
  assert.ok(chain.follow.now() <= STOCK_FINALITY_MAX_MS + 2000, `followed for ${chain.follow.now()} ms`)
})

test('recovery checks the network before it reads a pending row, and reads nothing when nothing is pending', async () => {
  const s = await collectionSetup({ crash: true })
  await assert.rejects(s.executor.collect(s.request), /crash/)
  const devnet = fakeChain({ endpoint: 'https://rpc.example', genesis: 'DevnetGenesis11111111111111111111111111111' })
  const elsewhere = createStockCollectionExecutor({ pool: null, connection: devnet.connection, config: null, env: ON, store: s.store, loadTransaction: loadFrom })
  await assert.rejects(elsewhere.recover(), { code: E.NETWORK })
  assert.deepEqual(devnet.calls, ['getGenesisHash'])
  const idle = fakeChain()
  const nothing = createStockCollectionExecutor({ pool: null, connection: idle.connection, config: null, env: ON, store: memoryStore(), loadTransaction: loadFrom })
  assert.deepEqual([await nothing.recover(), idle.calls], [[], []])
})

test('a collection below the floor, or from a graduated position without the opt-in, is held back with no key and no send', async () => {
  const s = await collectionSetup()
  const small = await curvePreview({ market: s.market, source: 'dbc_creator', signer: s.creator.publicKey.toBase58(), custody: s.custody,
    creatorFee: STOCK_COLLECTION_MIN_RAW - 1n })
  s.state.preview = previewOf(s.market, [small])
  assert.deepEqual((await s.executor.plan(s.market)).map(item => [item.source, item.status, item.termsHash]), [['dbc_creator', 'BELOW_MINIMUM', undefined]])
  assert.equal((await s.executor.collect({ ...s.request, termsHash: small.termsHash })).status, 'BELOW_MINIMUM')
  // A graduated position's MATCH is not executed by default: it needs the explicit opt-in (scripts/stock-execute.mjs --damm).
  const graduated = await dammPreview({ market: s.market, signer: s.creator.publicKey.toBase58(), custody: s.custody })
  s.state.preview = previewOf(s.market, [graduated])
  const [planned] = await s.executor.plan(s.market)
  assert.deepEqual([planned.source, planned.status, /--damm/.test(planned.reason)], ['damm_creator', 'NOT_ENABLED', true])
  assert.equal((await s.executor.collect({ repoId: s.market.repoId, source: 'damm_creator', termsHash: graduated.termsHash })).status, 'NOT_ENABLED')
  assert.deepEqual([s.loads, s.chain.sends, s.store.rows.collection.size], [[], [], 0])
  // Neither is loud in a pass.
  const pass = await runStockExecution({ collections: s.executor, listMarkets: async () => [s.market], execute: true })
  assert.deepEqual([pass.collections.map(item => item.status), stockExecutionLoud(pass)], [['NOT_ENABLED'], false])
})
