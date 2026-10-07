import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { EARLY_ACCESS_HOOK_PROGRAM_ID as HOOK, MAX_ALLOW_LIST, earlyAccessAddresses, platformAddress } from '../src/early-access-hook.mjs'
import { MIN_ORACLE_LAMPORTS, createEarlyAccessOracle, plannedChange } from '../src/early-access-oracle.mjs'

// Step 5f (docs/EARLY_ACCESS.md): the oracle keeps each open window's allow list equal to the contributors' linked wallets and closes
// the list after the window. Here with a scripted database and chain; on chain: tests/early-access-launch-chain.test.mjs.
const key = () => Keypair.generate().publicKey.toBase58()
const END = Date.parse('2026-10-07T12:15:00Z'), OPEN = END - 10 * 60_000
const discriminator = name => createHash('sha256').update(name).digest().subarray(0, 8)

test('the plan: add the missing linked wallets; remove an unlinked one only when the previous run agreed; hold a mass removal', () => {
  const [a, b, c, d] = [key(), key(), key(), key()]
  const plan = args => plannedChange({ end: END, now: OPEN, snapshot: 3, ...args })
  assert.deepEqual(plan({ list: [a, b], desired: [a, c] }), { add: [c], remove: [], unlinked: [b], held: 0, overflow: 0 }, 'first seen: pending')
  assert.deepEqual(plan({ list: [a, b], desired: [a, c], pending: new Set([b]) }), { add: [c], remove: [b], unlinked: [b], held: 0, overflow: 0 })
  assert.deepEqual(plan({ list: [a], desired: [a] }), { add: [], remove: [], unlinked: [], held: 0, overflow: 0 })
  assert.deepEqual(plan({ list: [a, b], desired: [], snapshot: 0, pending: new Set([a, b]) }), { add: [], remove: [], unlinked: [], held: 0, overflow: 0 },
    'no snapshot: nothing removed')
  assert.deepEqual(plan({ list: [a, b], desired: [], pending: new Set([a, b]) }), { add: [], remove: [a, b], unlinked: [a, b], held: 0, overflow: 0 },
    'a short list whose contributors all unlinked')
  // More than half of a list of more than four wallets: held, whatever the previous run saw.
  const six = [a, b, c, d, key(), key()]
  assert.deepEqual(plan({ list: six, desired: six.slice(0, 2), pending: new Set(six) }), { add: [], remove: [], unlinked: six.slice(2), held: 4, overflow: 0 })
  assert.deepEqual(plan({ list: six, desired: six.slice(0, 3), pending: new Set(six) }).remove, six.slice(3), 'half is not more than half')
  assert.deepEqual(plan({ list: null, desired: [a] }), { missing: true })
  // A full list takes only what fits.
  const full = Array.from({ length: MAX_ALLOW_LIST - 1 }, key)
  assert.deepEqual(plan({ list: full, desired: [...full, c, d], snapshot: 2000 }), { add: [c], remove: [], unlinked: [], held: 0, overflow: 1 })
  // The last 30 seconds: nothing; after the window: close once a minute has passed, if the list is still there.
  assert.deepEqual(plan({ list: [a], desired: [c], now: END - 30_000 }), {})
  assert.deepEqual(plan({ list: [a], desired: [], now: END + 59_999 }), {})
  assert.deepEqual(plan({ list: [a], desired: [], now: END + 60_000 }), { close: true })
  assert.deepEqual(plan({ list: null, desired: [], now: END + 60_000 }), {})
})

// A scripted database and chain: markets, the contributor snapshot and links, the on-chain lists (state.lists, changeable between runs);
// every sent transaction is recorded with what it was confirmed against.
function setup({ markets, links = {}, snapshot = {}, lists = {}, platformOracle = null, refuse = null, balance = 1_000_000_000 } = {}) {
  const oracle = Keypair.generate(), sent = [], confirms = [], queries = [], state = { lists }
  const allowListData = (mint, wallets) => Buffer.concat([Buffer.from('ea-allow'), new PublicKey(mint).toBuffer(),
    Buffer.from(Uint32Array.of(wallets.length).buffer), ...wallets.map(w => new PublicKey(w).toBuffer())])
  const db = { query: async (sql, params) => {
    queries.push(sql.trim().split(/\s+/).slice(0, 3).join(' '))
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] }
    if (/pg_advisory_unlock/.test(sql)) return { rows: [] }
    if (/from markets m/.test(sql)) return { rows: markets }
    if (/join github_wallet_links/.test(sql)) return { rows: (links[params[0]] ?? []).map(wallet => ({ wallet })) }
    if (/count\(\*\)::int as snapshot/.test(sql)) return { rows: [{ snapshot: snapshot[params[0]] ?? 0 }] }
    throw Error(`unexpected query ${sql}`)
  } }
  const pool = { ...db, connect: async () => ({ ...db, release() {} }) }
  const platform = Buffer.concat([discriminator('account:Platform'), Keypair.generate().publicKey.toBuffer(), (platformOracle ?? oracle.publicKey).toBuffer(), Buffer.from([1])])
  const configData = mint => { const data = Buffer.alloc(175); discriminator('account:MintConfig').copy(data); new PublicKey(mint).toBuffer().copy(data, 8); return data }
  let height = 100
  const connection = {
    getAccountInfo: async address => {
      if (address.equals(platformAddress())) return { owner: HOOK, data: platform }
      const market = markets.find(m => earlyAccessAddresses(m.mint).config.equals(address))
      return market ? { owner: HOOK, data: configData(market.mint) } : null
    },
    getBalance: async () => balance,
    getMultipleAccountsInfo: async addresses => addresses.map(address => {
      const market = markets.find(m => earlyAccessAddresses(m.mint).allowList.equals(address))
      return state.lists[market.mint] ? { owner: HOOK, data: allowListData(market.mint, state.lists[market.mint]) } : null
    }),
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: height++ }),
    simulateTransaction: async tx => ({ value: refuse?.(tx) ? { err: { InstructionError: [1, { Custom: 6005 }] },
      logs: [`Program ${HOOK.toBase58()} failed: custom program error: 0x1775`] } : { err: null, logs: [] } }),
    sendRawTransaction: async raw => { sent.push(raw); return `sig${sent.length}` },
    confirmTransaction: async strategy => { confirms.push(strategy); return { value: { err: null } } },
  }
  return { oracle, sent, confirms, queries, pool, connection, state }
}
const instructionsOf = raw => Transaction.from(raw).instructions.slice(1)
const create = (run, extra = {}) => createEarlyAccessOracle({ pool: run.pool, connection: run.connection, oracle: run.oracle, now: () => OPEN, log: () => {}, ...extra })

test('a run adds the missing linked wallets first (24 per transaction); an unlinked wallet leaves on the next run; then nothing is sent', async () => {
  const mint = key(), repoId = '700001', old = key(), listed = key()
  const linked = Array.from({ length: 30 }, key)
  const markets = [{ repoId, mint, earlyAccessEnd: new Date(END) }]
  const run = setup({ markets, links: { [repoId]: [listed, ...linked, 'not-a-wallet'] }, snapshot: { [repoId]: 40 }, lists: { [mint]: [listed, old] } })
  const logged = []
  const oracle = create(run, { log: record => logged.push(record) })
  const first = await oracle.runOnce()
  assert.deepEqual(first.results, [{ mint, added: 30, removed: 0, closed: false, signatures: ['sig1', 'sig2'] }], 'a malformed link row is skipped')
  const [firstAdd, secondAdd] = run.sent.map(instructionsOf).map(([ix]) => ix)
  assert.ok(firstAdd.data.subarray(0, 8).equals(discriminator('global:add_wallets')))
  assert.deepEqual([firstAdd.data.readUInt32LE(8), secondAdd.data.readUInt32LE(8)], [24, 6])
  // Each confirmation waits on the blockhash its transaction was built with.
  assert.deepEqual(run.confirms.map(strategy => strategy.blockhash), run.sent.map(raw => Transaction.from(raw).recentBlockhash))
  // The chain now holds the linked wallets and the old one: the second run finds it unlinked again and removes it.
  run.state.lists = { [mint]: [listed, old, ...linked] }
  const second = await oracle.runOnce()
  assert.deepEqual(second.results, [{ mint, added: 0, removed: 1, closed: false, signatures: ['sig3'] }])
  const [[removal]] = run.sent.slice(2).map(instructionsOf)
  assert.ok(removal.data.subarray(0, 8).equals(discriminator('global:remove_wallets')))
  assert.equal(removal.data.readUInt32LE(8), 1)
  assert.ok(removal.keys[0].pubkey.equals(run.oracle.publicKey) && removal.keys[0].isSigner, 'the oracle removes')
  run.state.lists = { [mint]: [listed, ...linked] }
  assert.deepEqual((await oracle.runOnce()).results, [{ mint, added: 0, removed: 0, closed: false }])
  assert.equal(run.sent.length, 3)
  assert.deepEqual(logged.map(record => [record.added, record.removed]), [[30, 0], [0, 1]])
})

test('a link that comes back before the next run is never removed; a restarted oracle waits a run before removing', async () => {
  const mint = key(), repoId = '700004', [a, b] = [key(), key()]
  const markets = [{ repoId, mint, earlyAccessEnd: new Date(END) }], links = { [repoId]: [a] }
  const run = setup({ markets, links, snapshot: { [repoId]: 2 }, lists: { [mint]: [a, b] } })
  const oracle = create(run)
  const removed = async using => (await using.runOnce()).results[0].removed
  assert.equal(await removed(oracle), 0, 'b unlinked: pending')
  links[repoId] = [a, b]
  assert.equal(await removed(oracle), 0, 'b linked again: kept, and no longer pending')
  links[repoId] = [a]
  assert.equal(await removed(oracle), 0, 'unlinked again: pending again')
  assert.equal(await removed(create(run)), 0, 'a restarted oracle starts over')
  assert.equal(await removed(oracle), 1, 'two runs in a row agree')
  assert.equal(run.sent.length, 1)
})

test('nothing is sent when the platform names another oracle or a change does not simulate; a low balance stops adds only', async () => {
  const mint = key(), repoId = '700002'
  const markets = [{ repoId, mint, earlyAccessEnd: new Date(END) }]
  const other = setup({ markets, links: { [repoId]: [key()] }, lists: { [mint]: [] }, platformOracle: Keypair.generate().publicKey })
  const logged = []
  assert.deepEqual(await create(other, { log: record => logged.push(record) }).runOnce(), { status: 'ORACLE_MISMATCH' })
  assert.equal(other.sent.length, 0)
  assert.deepEqual(logged, [{ error: 'ORACLE_NOT_PLATFORM_ORACLE' }])
  const refused = setup({ markets, links: { [repoId]: [key()] }, lists: { [mint]: [] }, refuse: () => true })
  assert.deepEqual((await create(refused).runOnce()).results, [{ mint, added: 0, removed: 0, closed: false, error: 'WindowClosed' }])
  assert.equal(refused.sent.length, 0)
  const none = setup({ markets: [] })
  assert.deepEqual(await create(none).runOnce(), { status: 'IDLE' })
  const missing = setup({ markets, links: { [repoId]: [key()] } })
  assert.deepEqual((await create(missing).runOnce()).results, [{ mint, error: 'NO_ALLOW_LIST' }])
  const poor = setup({ markets, links: { [repoId]: [key(), key()] }, lists: { [mint]: [] }, balance: MIN_ORACLE_LAMPORTS - 1 })
  const poorLog = []
  const waiting = await create(poor, { log: record => poorLog.push(record) }).runOnce()
  assert.deepEqual(waiting.results, [{ mint, added: 0, removed: 0, closed: false, waiting: 2 }])
  assert.equal(poor.sent.length, 0)
  assert.deepEqual(poorLog[0], { error: 'ORACLE_LOW_BALANCE', lamports: MIN_ORACLE_LAMPORTS - 1 })
})

test('a run stops sending once its time budget is spent; the next run goes on', async () => {
  const mint = key(), repoId = '700005'
  const markets = [{ repoId, mint, earlyAccessEnd: new Date(END) }]
  const run = setup({ markets, links: { [repoId]: Array.from({ length: 30 }, key) }, lists: { [mint]: [] } })
  let t = 0
  const result = await create(run, { clock: () => (t += 30_000) }).runOnce()
  assert.deepEqual(result.results, [{ mint, added: 24, removed: 0, closed: false, signatures: ['sig1'], error: 'RUN_BUDGET' }])
})

test('after the window the list is closed: rent back to the mint config\'s receiver and the oracle', async () => {
  const mint = key(), repoId = '700003'
  const markets = [{ repoId, mint, earlyAccessEnd: new Date(END) }]
  const run = setup({ markets, lists: { [mint]: [key()] } })
  const result = await create(run, { now: () => END + 120_000 }).runOnce()
  assert.deepEqual(result.results, [{ mint, added: 0, removed: 0, closed: true, signatures: ['sig1'] }])
  const [[close]] = run.sent.map(instructionsOf)
  const { allowList, config } = earlyAccessAddresses(mint)
  assert.deepEqual(close.keys.map(meta => meta.pubkey.toBase58()), [config.toBase58(), platformAddress().toBase58(), allowList.toBase58(),
    '11111111111111111111111111111111', run.oracle.publicKey.toBase58()], 'the receiver is the mint config\'s rent receiver (zeroed here)')
  assert.ok(!run.queries.some(sql => /join/.test(sql)), 'no contributor read after the window')
})
