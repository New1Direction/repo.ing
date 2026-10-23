import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import bs58 from 'bs58'
import { Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { MigrationOption } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk'

// Real finalized $REPOING DAMM accounts; the chain around them is faked so no RPC is touched.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/repoing-graduated-accounts.json', import.meta.url), 'utf8'))
const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const MIGRATE = bs58.encode(Buffer.from([156,169,230,103,53,228,80,64]))
const key = value => new PublicKey(value)
const config = '2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M'
const market = { githubRepoId: '1388219884', mint: '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be',
  pool: 'Gda7Sig9EtVpB7EMVWG1eAAoX8kvq4j68nELsnq3Qfi7', creatorWallet: 'FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1' }
const [target, position, nftAccount, partnerPosition, partnerNftAccount] = fixture.accounts.map(a => a.address)
const nftMint = '7QdbWrPPAmsGrm2VVc9Eyt2gj4HDnjt7doxv3GUVBUx7', partnerNftMint = '63nLdMVdn7H4QHLQx6jP2mvKmSjANSnib1yx5iujtzYV'
const state = { poolState: { config: key(config), baseMint: key(market.mint), creator: key(market.creatorWallet), isMigrated: 1 } }
const fixed = { migrationOption: MigrationOption.MET_DAMM_V2, quoteMint: NATIVE_MINT, creatorPermanentLockedLiquidityPercentage: 50,
  partnerPermanentLockedLiquidityPercentage: 50, migrationFeeOption: 2, feeClaimer: key('H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3') }
const MIGRATION = 'migration-signature', SLOT = 451432143

function migrationTx(overrides = {}) {
  const a = { 0: market.pool, 2: config, 4: target, 5: nftMint, 6: nftAccount, 7: position, 8: partnerNftMint, 9: partnerNftAccount,
    10: partnerPosition, 12: CP_AMM_PROGRAM_ID.toBase58(), 13: market.mint, 14: NATIVE_MINT.toBase58(), ...overrides }
  const accounts = Array.from({ length: 15 }, (_, i) => a[i] ? key(a[i]) : Keypair.generate().publicKey)
  return { slot: SLOT, meta: { err: null, innerInstructions: [] }, transaction: { message: {
    accountKeys: [DBC, ...accounts], instructions: [{ programIdIndex: 0, accounts: accounts.map((_, i) => i + 1), data: MIGRATE }] } } }
}
const noise = { slot: SLOT + 1, meta: { err: null, innerInstructions: [] }, transaction: { message: { accountKeys: [DBC], instructions: [] } } }

// Curve history newest-first: `newer` successful txs after the migration, a failed one, the migration, then curve trades.
function chain({ newer = 3, endpoint, accounts = fixture.accounts } = {}) {
  const history = [...Array.from({ length: newer }, (_, i) => ({ signature: `after-${i}`, err: null })), { signature: 'failed', err: { x: 1 } },
    { signature: MIGRATION, err: null }, ...Array.from({ length: 5 }, (_, i) => ({ signature: `trade-${i}`, err: null }))]
  const calls = { signatures: [], loads: [] }
  const connection = { rpcEndpoint: endpoint,
    async getSignaturesForAddress(address, { limit, before }) {
      calls.signatures.push(address.toBase58())
      assert.equal(address.toBase58(), market.pool, 'only the settled curve history may be paged')
      const start = before ? history.findIndex(h => h.signature === before) + 1 : 0
      return history.slice(start, start + limit)
    },
    async getMultipleAccountsInfoAndContext(keys) {
      return { context: { slot: fixture.slot }, value: keys.map(k => {
        const a = accounts.find(x => x.address === k.toBase58())
        return a && { owner: key(a.owner), data: Buffer.from(a.data, 'base64'), lamports: 1, executable: false }
      }) }
    } }
  const loadTransaction = async (_c, signature) => {
    calls.loads.push(signature)
    if (signature === 'failed') throw Error('failed transactions must not be loaded')
    return signature === MIGRATION ? migrationTx() : noise
  }
  return { connection, loadTransaction, calls }
}
function database() {
  const rows = new Map(), queries = []
  const names = ['curve','config','mint','pool','signature','slot','creatorPosition','creatorNftAccount','creatorNftMint','partnerPosition','partnerNftAccount','partnerNftMint']
  return { rows, queries, async query(text, params) {
    queries.push(text.trim().split(/\s+/)[0])
    assert.match(text, /graduated_migration_proofs/)
    if (/^insert/.test(text.trim())) {
      assert.match(text, /on conflict \(github_repo_id\) do nothing/)
      if (!rows.has(params[0])) rows.set(params[0], Object.fromEntries(names.map((n, i) => [n, params[i + 1]])))
      return { rows: [] }
    }
    return { rows: rows.has(params[0]) ? [{ ...rows.get(params[0]) }] : [] }
  } }
}
// A fresh module instance models a cold process with an empty in-memory proof cache.
let instance = 0
const coldProcess = async () => (await import(`../src/graduated-fees.mjs?cold=${instance++}`)).createGraduatedFees

test('first read proves the migration from curve history and stores it once', async () => {
  const db = database(), { connection, loadTransaction, calls } = chain({ endpoint: 'fake://first' })
  const snapshot = await (await coldProcess())({ connection, config, db, loadTransaction }).read(market, state, fixed)
  assert.equal(snapshot.pool.toBase58(), target)
  assert.equal(snapshot.position.toBase58(), position)
  assert.equal(snapshot.partner.position.toBase58(), partnerPosition)
  assert.equal(snapshot.evidence.migration, MIGRATION)
  assert.deepEqual(calls.signatures, [market.pool])
  assert.deepEqual(calls.loads, ['after-0', 'after-1', 'after-2', MIGRATION])
  assert.deepEqual(db.rows.get('1388219884'), { curve: market.pool, config, mint: market.mint, pool: target, signature: MIGRATION, slot: String(SLOT),
    creatorPosition: position, creatorNftAccount: nftAccount, creatorNftMint: nftMint,
    partnerPosition, partnerNftAccount, partnerNftMint })
})

test('cold reads use the stored proof without paging history, and writes are idempotent', async () => {
  const db = database(), first = chain({ endpoint: 'fake://warm-a' })
  await (await coldProcess())({ connection: first.connection, config, db, loadTransaction: first.loadTransaction }).read(market, state, fixed)
  const before = await (await coldProcess())({ connection: first.connection, config, db, loadTransaction: first.loadTransaction }).read(market, state, fixed)
  const { connection, loadTransaction, calls } = chain({ endpoint: 'fake://warm-b', newer: 5000 })
  const fees = (await coldProcess())({ connection, config, db, loadTransaction })
  const snapshot = await fees.read(market, state, fixed)
  await fees.read(market, state, fixed)
  assert.equal(calls.signatures.length, 0)
  assert.deepEqual(calls.loads, [MIGRATION])
  assert.equal(snapshot.hash, before.hash)
  assert.equal(db.queries.filter(q => q === 'insert').length, 1)
})

test('the migration is found beyond the first history page', async () => {
  const db = database(), { connection, loadTransaction, calls } = chain({ endpoint: 'fake://deep', newer: 1500 })
  const snapshot = await (await coldProcess())({ connection, config, db, loadTransaction }).read(market, state, fixed)
  assert.equal(snapshot.evidence.migration, MIGRATION)
  assert.equal(calls.signatures.length, 2)
  assert.equal(db.rows.get('1388219884').signature, MIGRATION)
})

test('a stored proof that the finalized migration does not reproduce is rejected', async () => {
  for (const [field, value] of [['partnerPosition', Keypair.generate().publicKey.toBase58()], ['slot', String(SLOT - 1)],
    ['pool', Keypair.generate().publicKey.toBase58()], ['config', Keypair.generate().publicKey.toBase58()]]) {
    const db = database(), seed = chain({ endpoint: `fake://seed-${field}` })
    await (await coldProcess())({ connection: seed.connection, config, db, loadTransaction: seed.loadTransaction }).read(market, state, fixed)
    db.rows.set('1388219884', { ...db.rows.get('1388219884'), [field]: value })
    const { connection, loadTransaction, calls } = chain({ endpoint: `fake://tampered-${field}` })
    await assert.rejects((await coldProcess())({ connection, config, db, loadTransaction }).read(market, state, fixed), /Stored graduated migration proof mismatch/)
    assert.equal(calls.signatures.length, 0)
  }
})

test('a stored proof whose current accounts moved fails the per-read checks', async () => {
  const db = database(), seed = chain({ endpoint: 'fake://moved-seed' })
  await (await coldProcess())({ connection: seed.connection, config, db, loadTransaction: seed.loadTransaction }).read(market, state, fixed)
  // The creator NFT left the creator wallet (token account owner field at bytes 32..64).
  const data = Buffer.from(fixture.accounts[2].data, 'base64')
  Keypair.generate().publicKey.toBuffer().copy(data, 32)
  const accounts = fixture.accounts.map((a, i) => i === 2 ? { ...a, data: data.toString('base64') } : a)
  const { connection, loadTransaction } = chain({ endpoint: 'fake://moved', accounts })
  await assert.rejects((await coldProcess())({ connection, config, db, loadTransaction }).read(market, state, fixed), /Graduated creator position/)
  const gone = chain({ endpoint: 'fake://gone', accounts: fixture.accounts.filter((_, i) => i !== 3) })
  await assert.rejects((await coldProcess())({ connection: gone.connection, config, db, loadTransaction: gone.loadTransaction }).read(market, state, fixed), /Invalid DAMM account owner/)
})

test('a proof that fails current checks is never persisted', async () => {
  const db = database(), accounts = fixture.accounts.filter((_, i) => i !== 1)
  const { connection, loadTransaction } = chain({ endpoint: 'fake://unpersisted', accounts })
  await assert.rejects((await coldProcess())({ connection, config, db, loadTransaction }).read(market, state, fixed), /Invalid DAMM account owner/)
  assert.equal(db.rows.size, 0)
})

test('a conflicting concurrent write fails closed', async () => {
  const db = database(), { connection, loadTransaction } = chain({ endpoint: 'fake://race' })
  const query = db.query
  db.query = async (text, params) => {
    // Another writer lands a different row between our lookup and insert.
    if (/^insert/.test(text.trim())) db.rows.set(params[0], { ...Object.fromEntries(Object.keys(db.rows.get(params[0]) ?? {}).map(k => [k, ''])), signature: 'other' })
    return query(text, params)
  }
  await assert.rejects((await coldProcess())({ connection, config, db, loadTransaction }).read(market, state, fixed), /Conflicting graduated migration proof/)
})

test('non-graduated markets and callers without a database are unchanged', async () => {
  const db = database(), { connection, loadTransaction, calls } = chain({ endpoint: 'fake://curve' })
  const fees = (await coldProcess())({ connection, config, db, loadTransaction })
  assert.equal(await fees.read(market, { poolState: { ...state.poolState, isMigrated: 0 } }, fixed), null)
  assert.equal(calls.signatures.length + calls.loads.length + db.queries.length, 0)
  const bare = chain({ endpoint: 'fake://bare' })
  const snapshot = await (await coldProcess())({ connection: bare.connection, config, loadTransaction: bare.loadTransaction }).read(market, state, fixed)
  assert.equal(snapshot.evidence.migration, MIGRATION)
  assert.equal(bare.calls.signatures.length, 1)
})

const failing = (code, when = () => true) => {
  const db = database(), query = db.query
  db.query = async (text, params) => {
    if (when(text)) { db.queries.push('failed'); throw Object.assign(Error(`db failure ${code}`), { code }) }
    return query(text, params)
  }
  return db
}

test('a missing proof table falls back to the chain scan and logs once per process', async t => {
  const logged = []
  t.mock.method(console, 'error', message => logged.push(message))
  const db = failing('42P01'), { connection, loadTransaction, calls } = chain({ endpoint: 'fake://missing-table' })
  const fees = (await coldProcess())({ connection, config, db, loadTransaction })
  const snapshot = await fees.read(market, state, fixed)
  assert.equal(snapshot.evidence.migration, MIGRATION)
  assert.equal(snapshot.position.toBase58(), position)
  assert.equal(snapshot.partner.position.toBase58(), partnerPosition)
  await fees.read(market, state, fixed)
  assert.equal(calls.signatures.length, 1, 'the per-process cache still holds the scanned proof')
  assert.deepEqual(db.queries, ['failed'])
  assert.deepEqual(logged, ['graduated migration proof table missing; using chain scan'])
  const insertOnly = failing('42P01', text => /^insert/.test(text.trim())), fresh = chain({ endpoint: 'fake://missing-on-insert' })
  const again = await (await coldProcess())({ connection: fresh.connection, config, db: insertOnly, loadTransaction: fresh.loadTransaction }).read(market, state, fixed)
  assert.equal(again.evidence.migration, MIGRATION)
  assert.equal(insertOnly.rows.size, 0)
})

test('other database errors still fail the read', async t => {
  t.mock.method(console, 'error', () => {})
  for (const [code, when] of [['57P01', () => true], [undefined, () => true]]) {
    const db = failing(code, when), { connection, loadTransaction } = chain({ endpoint: `fake://db-error-${code}-${when.length}` })
    await assert.rejects((await coldProcess())({ connection, config, db, loadTransaction }).read(market, state, fixed), /db failure/)
  }
})

test('a unique-key conflict on the insert (another read stored it at once) is checked against the stored row', async t => {
  t.mock.method(console, 'error', () => {})
  // Nothing stored under this repository: the conflict was another market's row, so it is a conflicting proof.
  const lone = failing('23505', text => /^insert/.test(text.trim())), first = chain({ endpoint: 'fake://unique-lone' })
  await assert.rejects((await coldProcess())({ connection: first.connection, config, db: lone, loadTransaction: first.loadTransaction }).read(market, state, fixed),
    /Conflicting graduated migration proof; review required/)
  // The same proof stored by the concurrent read: the read goes on with it.
  const db = database(), seed = chain({ endpoint: 'fake://unique-seed' })
  await (await coldProcess())({ connection: seed.connection, config, db, loadTransaction: seed.loadTransaction }).read(market, state, fixed)
  const stored = db.rows.get('1388219884'), select = db.query
  db.rows.delete('1388219884')
  db.query = async (text, params) => {
    if (/^insert/.test(text.trim())) { db.rows.set('1388219884', stored); throw Object.assign(Error('duplicate key'), { code: '23505' }) }
    return select(text, params)
  }
  const raced = chain({ endpoint: 'fake://unique-raced' })
  const snapshot = await (await coldProcess())({ connection: raced.connection, config, db, loadTransaction: raced.loadTransaction }).read(market, state, fixed)
  assert.equal(snapshot.evidence.migration, MIGRATION)
})

test('a mismatched stored row still throws when the fallback exists', async () => {
  const db = database(), seed = chain({ endpoint: 'fake://fallback-mismatch-seed' })
  await (await coldProcess())({ connection: seed.connection, config, db, loadTransaction: seed.loadTransaction }).read(market, state, fixed)
  db.rows.set('1388219884', { ...db.rows.get('1388219884'), creatorPosition: Keypair.generate().publicKey.toBase58() })
  const { connection, loadTransaction } = chain({ endpoint: 'fake://fallback-mismatch' })
  await assert.rejects((await coldProcess())({ connection, config, db, loadTransaction }).read(market, state, fixed), /Stored graduated migration proof mismatch/)
})

const recoveryVault = '3dHCTpgdx15yXyVGh7DK1woQ1XisQpmFCxncURrq63Gs'
const recoveryBindings = () => ({ version: 1, poolCreators: [], positions: [
  { role: 'creator', repoId: market.githubRepoId, curve: market.pool, config, mint: market.mint, pool: target,
    migration: MIGRATION, position, nftAccount, nftMint, previousOwner: market.creatorWallet, owner: recoveryVault },
  { role: 'partner', repoId: market.githubRepoId, curve: market.pool, config, mint: market.mint, pool: target,
    migration: MIGRATION, position: partnerPosition, nftAccount: partnerNftAccount, nftMint: partnerNftMint,
    previousOwner: fixed.feeClaimer.toBase58(), owner: recoveryVault },
] })
const movedAccounts = () => fixture.accounts.map((a, i) => {
  const data = Buffer.from(a.data, 'base64')
  if (i === 2 || i === 4) key(recoveryVault).toBuffer().copy(data, 32)
  return { ...a, data: data.toString('base64') }
})

test('approved custody changes preserve separate fee entitlements without authorizing a default reader', async () => {
  const create = await coldProcess(), baseline = chain({ endpoint: 'fake://recovery-baseline' })
  const before = await create({ ...baseline, config }).read(market, state, fixed)
  const moved = chain({ endpoint: 'fake://recovery-moved', accounts: movedAccounts() })
  const bindings = recoveryBindings()
  const reader = create({ ...moved, config, custodyRecovery: bindings })
  // Mutating caller-owned configuration cannot change an already constructed reader's approval.
  bindings.positions[0].owner = market.creatorWallet
  const after = await reader.read(market, state, fixed)
  for (const side of [null, 'partner']) {
    const a = side ? after[side] : after, b = side ? before[side] : before
    assert.deepEqual([a.available, a.claimed, a.earned], [b.available, b.claimed, b.earned])
    assert.equal(a.nftAccount.toBase58(), b.nftAccount.toBase58())
  }
  assert.equal(market.creatorWallet, recoveryBindings().positions[0].previousOwner)
  // Same connection and module cache, but no custody approval: legacy claim/trade readers stay strict.
  await assert.rejects(create({ ...moved, config }).read(market, state, fixed), /Graduated creator position/)
  for (const field of ['repoId', 'curve', 'config', 'mint', 'pool', 'migration', 'position', 'nftMint', 'previousOwner', 'role']) {
    const invalid = recoveryBindings()
    invalid.positions[0][field] = field === 'repoId' ? '999' : field === 'migration' ? 'another-migration'
      : field === 'role' ? 'partner' : fixed.feeClaimer.toBase58()
    await assert.rejects(async () => create({ ...moved, config, custodyRecovery: invalid }).read(market, state, fixed), /custody binding/i)
  }
  await assert.rejects(reader.read(market, state, { ...fixed, feeClaimer: key(recoveryVault) }), /custody binding/i)
  await assert.rejects(create({ ...baseline, config, custodyRecovery: recoveryBindings() }).read(market, state, fixed), /Graduated creator position/)
})

test('pool creator recovery is separately bound and never rewrites the historical market creator', async () => {
  const create = await coldProcess(), c = chain({ endpoint: 'fake://creator-recovery' })
  const before = await create({ ...c, config }).read(market, state, fixed)
  const changed = { poolState: { ...state.poolState, creator: key(recoveryVault) } }
  const custodyRecovery = { version: 1, positions: [], poolCreators: [{ repoId: market.githubRepoId,
    curve: market.pool, config, mint: market.mint, previousOwner: market.creatorWallet, owner: recoveryVault }] }
  const after = await create({ ...c, config, custodyRecovery }).read(market, changed, fixed)
  assert.deepEqual([after.earned, after.partner.earned], [before.earned, before.partner.earned])
  await assert.rejects(create({ ...c, config }).read(market, changed, fixed), /Invalid canonical creator pool/)
  await assert.rejects(create({ ...c, config, custodyRecovery }).read(market, state, fixed), /Invalid canonical creator pool/)
  const invalid = { ...custodyRecovery, poolCreators: [{ ...custodyRecovery.poolCreators[0], repoId: '999' }] }
  await assert.rejects(create({ ...c, config, custodyRecovery: invalid }).read(market, changed, fixed), /custody binding/i)
})

test('custody approval rejects ambiguous manifests and unsafe current NFT controls', async () => {
  const create = await coldProcess(), c = chain({ endpoint: 'fake://invalid-recovery', accounts: movedAccounts() })
  for (const manifest of [ { ...recoveryBindings(), version: 2 }, { version: 1 },
    { ...recoveryBindings(), positions: [...recoveryBindings().positions, recoveryBindings().positions[0]] } ]) {
    assert.throws(() => create({ ...c, config, custodyRecovery: manifest }), /custody/i)
  }
  for (const accountIndex of [2, 4]) for (const mutate of [
    b => b.writeBigUInt64LE(0n, 64), b => b.writeUInt32LE(1, 72), b => { b[108] = 2 },
    b => { b.writeUInt32LE(1, 129); key(market.creatorWallet).toBuffer().copy(b, 133) },
  ]) {
    const accounts = movedAccounts(), data = Buffer.from(accounts[accountIndex].data, 'base64')
    mutate(data); accounts[accountIndex].data = data.toString('base64')
    const invalid = chain({ endpoint: `fake://unsafe-custody-${instance++}`, accounts })
    await assert.rejects(create({ ...invalid, config, custodyRecovery: recoveryBindings() }).read(market, state, fixed), /Graduated (creator|partner) position/)
  }
})
