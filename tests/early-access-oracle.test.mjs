import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { EARLY_ACCESS_HOOK_PROGRAM_ID as HOOK, MAX_ALLOW_LIST, decodeMintConfig, earlyAccessAddresses, platformAddress, starBonusBps } from '../src/early-access-hook.mjs'
import { MIN_ORACLE_LAMPORTS, createEarlyAccessOracle, plannedChange, starReportNeeded } from '../src/early-access-oracle.mjs'

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
function setup({ markets, starMarkets = [], configs = {}, links = {}, snapshot = {}, lists = {}, platformOracle = null, refuse = null,
  balance = 1_000_000_000, starQueryError = null } = {}) {
  const oracle = Keypair.generate(), sent = [], confirms = [], queries = [], state = { lists, configs }
  const allowListData = (mint, wallets) => Buffer.concat([Buffer.from('ea-allow'), new PublicKey(mint).toBuffer(),
    Buffer.from(Uint32Array.of(wallets.length).buffer), ...wallets.map(w => new PublicKey(w).toBuffer())])
  const db = { query: async (sql, params) => {
    queries.push(sql.trim().split(/\s+/).slice(0, 3).join(' '))
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] }
    if (/pg_advisory_unlock/.test(sql)) return { rows: [] }
    if (/hook_rules/.test(sql)) { if (starQueryError) throw starQueryError; return { rows: starMarkets } }
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
      const starMarket = starMarkets.find(m => earlyAccessAddresses(m.mint).config.equals(address))
      if (starMarket) return state.configs[starMarket.mint] ?? null
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
  // A wrong key shows in the log once per process even before any window opens (runbook step 6); nothing is sent.
  const early = setup({ markets: [], platformOracle: Keypair.generate().publicKey }), earlyLog = []
  const idle = create(early, { log: record => earlyLog.push(record) })
  assert.deepEqual([await idle.runOnce(), await idle.runOnce()], [{ status: 'IDLE' }, { status: 'IDLE' }])
  assert.deepEqual(earlyLog, [{ error: 'ORACLE_NOT_PLATFORM_ORACLE' }])
  assert.equal(early.sent.length, 0)
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

// Star unlocks: a mint config in its real layout, with the launch's settings (+0.5% per 100 stars, at most +5%).
function starConfigOf(mint, { repoId = '0', rules = 7, starsAtLaunch = 10, starsNow = starsAtLaunch } = {}) {
  const data = Buffer.alloc(175)
  discriminator('account:MintConfig').copy(data); new PublicKey(mint).toBuffer().copy(data, 8)
  data.writeBigUInt64LE(BigInt(repoId), 40)
  data[48] = rules
  data.writeUInt32LE(rules & 4 ? starsAtLaunch : 0, 151); data.writeUInt32LE(rules & 4 ? 100 : 0, 155)
  data.writeUInt16LE(rules & 4 ? 50 : 0, 159); data.writeUInt16LE(rules & 4 ? 500 : 0, 161); data.writeUInt32LE(starsNow, 163)
  return { owner: HOOK, data }
}

test('star unlocks: a report is needed only when the bonus changes, down as well as up, never past the cap', () => {
  const config = starsNow => decodeMintConfig(starConfigOf(key(), { starsNow }).data)
  assert.deepEqual([9, 10, 109, 110, 1009, 1010, 5000].map(stars => starBonusBps(config(10).ramp, stars)), [0, 0, 0, 50, 450, 500, 500])
  assert.equal(starReportNeeded(config(10), 109), false)
  assert.equal(starReportNeeded(config(10), 110), true)
  assert.equal(starReportNeeded(config(150), 60), true, 'stars taken back')
  assert.equal(starReportNeeded(config(150), 205), false, 'the same step')
  assert.equal(starReportNeeded(config(1010), 9000), false, 'at the cap')
  assert.equal(starReportNeeded(config(1010), 1009), true)
  assert.equal(starBonusBps(decodeMintConfig(starConfigOf(key(), { rules: 3 }).data).ramp, 9000), 0, 'no star unlocks: no bonus')
})

test('star unlocks: the oracle reads each repository every 15 minutes and reports its stars when the bonus changes', async () => {
  const [mint, other, ramp, gone] = [key(), key(), key(), key()]
  const starMarkets = [{ repoId: '700010', mint }, { repoId: '700011', mint: other }, { repoId: '700012', mint: ramp }, { repoId: '700013', mint: gone }]
  const stars = { 700010: 260, 700011: 50, 700012: 900, 700013: null }, reads = []
  const starConfig = starConfigOf
  const run = setup({ markets: [], starMarkets, configs: { [mint]: starConfig(mint, { repoId: '700010' }), [other]: starConfig(other, { repoId: '700011' }),
    [ramp]: starConfig(ramp, { repoId: '700012', rules: 3 }), [gone]: starConfig(gone, { repoId: '700013' }) } })
  let t = 0
  const logged = []
  const oracle = create(run, { clock: () => t, log: record => logged.push(record), readStars: async id => { reads.push(id); return stars[id] } })
  const first = await oracle.runOnce()
  assert.deepEqual(first, { status: 'OK', results: [], stars: [{ mint, stars: 260, reported: true, signature: 'sig1' }, { mint: other, stars: 50 },
    { mint: ramp, error: 'MINT_CONFIG_MISMATCH' }, { mint: gone, error: 'STARS_UNREADABLE' }] })
  const [[report]] = run.sent.map(instructionsOf)
  assert.ok(report.data.subarray(0, 8).equals(discriminator('global:report_stars')))
  assert.equal(report.data.readUInt32LE(8), 260)
  // The oracle signs (and pays, so the message marks it writable); only the mint config changes.
  assert.deepEqual(report.keys.map(meta => [meta.pubkey.toBase58(), meta.isSigner, meta.isWritable]), [[run.oracle.publicKey.toBase58(), true, true],
    [platformAddress().toBase58(), false, false], [earlyAccessAddresses(mint).config.toBase58(), false, true]])
  assert.deepEqual(logged.map(record => record.stars.mint), [mint, ramp, gone], 'reports and problems are logged')
  assert.deepEqual(reads, ['700010', '700011', '700013'], 'a config that is not star unlocks is never read from GitHub')
  // Within 15 minutes nothing is read again (and nothing is read from the chain); after, the chain holds the report and a count in
  // the same step sends nothing.
  t += 14 * 60_000
  assert.deepEqual(await oracle.runOnce(), { status: 'IDLE' })
  run.state.configs[mint] = starConfig(mint, { repoId: '700010', starsNow: 260 })
  stars[700010] = 299
  t += 60_000
  assert.deepEqual((await oracle.runOnce()).stars[0], { mint, stars: 299 })
  // Stars taken back lower the bonus: reported too.
  stars[700010] = 100
  t += 15 * 60_000
  assert.deepEqual((await oracle.runOnce()).stars[0], { mint, stars: 100, reported: true, signature: 'sig2' })
  assert.equal(run.sent.length, 2)
})

test('star unlocks: a refused report and a failed read are logged; the platform must name the oracle; the run budget holds', async () => {
  const mint = key(), starMarkets = [{ repoId: '700020', mint }], starConfig = (m, options) => starConfigOf(m, { repoId: '700020', ...options })
  const refused = setup({ markets: [], starMarkets, configs: { [mint]: starConfig(mint) }, refuse: () => true })
  assert.deepEqual((await create(refused, { readStars: async () => 500 }).runOnce()).stars, [{ mint, stars: 500, error: 'WindowClosed' }])
  assert.equal(refused.sent.length, 0)
  const failing = setup({ markets: [], starMarkets, configs: { [mint]: starConfig(mint) } })
  assert.deepEqual((await create(failing, { readStars: async () => { throw new TypeError('fetch failed') } }).runOnce()).stars, [{ mint, error: 'TypeError' }])
  const mismatch = setup({ markets: [], starMarkets, configs: { [mint]: starConfig(mint) }, platformOracle: Keypair.generate().publicKey })
  assert.deepEqual(await create(mismatch, { readStars: async () => 500 }).runOnce(), { status: 'ORACLE_MISMATCH' })
  const missing = setup({ markets: [], starMarkets })
  assert.deepEqual((await create(missing, { readStars: async () => 500 }).runOnce()).stars, [{ mint, error: 'NO_MINT_CONFIG' }])
  let t = 0
  const slow = setup({ markets: [], starMarkets, configs: { [mint]: starConfig(mint) } })
  assert.deepEqual(await create(slow, { clock: () => (t += 50_000), readStars: async () => 500 }).runOnce(), { status: 'OK', results: [] },
    'past the budget: left for the next run')
})

test('star unlocks: a config for another repository is refused; GitHub\'s rate limit ends the run\'s reads; a low balance waits', async () => {
  const [a, b, c] = [key(), key(), key()]
  const starMarkets = [{ repoId: '700030', mint: a }, { repoId: '700031', mint: b }, { repoId: '700032', mint: c }]
  const configs = { [a]: starConfigOf(a, { repoId: '700099' }), [b]: starConfigOf(b, { repoId: '700031' }), [c]: starConfigOf(c, { repoId: '700032' }) }
  const reads = [], logged = []
  const limited = setup({ markets: [], starMarkets, configs })
  const result = await create(limited, { log: record => logged.push(record), readStars: async id => { reads.push(id); throw Error('GITHUB_REPOSITORY_HTTP_429') } }).runOnce()
  assert.deepEqual(result.stars, [{ mint: a, error: 'MINT_CONFIG_MISMATCH' }, { mint: b, error: 'GITHUB_REPOSITORY_HTTP_429' }])
  assert.deepEqual(reads, ['700031'], 'the mismatched config is never read from GitHub; after the rate limit nothing more')
  assert.deepEqual(logged.map(record => record.stars.error), ['MINT_CONFIG_MISMATCH', 'GITHUB_REPOSITORY_HTTP_429'])
  const poor = setup({ markets: [], starMarkets, configs, balance: MIN_ORACLE_LAMPORTS - 1 }), poorReads = []
  assert.deepEqual(await create(poor, { readStars: async id => { poorReads.push(id); return 900 } }).runOnce(), { status: 'OK', results: [] })
  assert.deepEqual([poorReads, poor.sent.length], [[], 0], 'nothing read or sent while the balance is low')
})

test('a failing star query never stops the lists\' upkeep, and is logged once', async () => {
  const mint = key(), repoId = '700040', logged = []
  const markets = [{ repoId, mint, earlyAccessEnd: new Date(END) }]
  const run = setup({ markets, links: { [repoId]: [key()] }, snapshot: { [repoId]: 1 }, lists: { [mint]: [] },
    starQueryError: Object.assign(Error('column m.hook_rules does not exist'), { code: '42703' }) })
  const oracle = create(run, { log: record => logged.push(record) })
  assert.deepEqual((await oracle.runOnce()).results, [{ mint, added: 1, removed: 0, closed: false, signatures: ['sig1'] }])
  await oracle.runOnce()
  assert.deepEqual(logged.filter(record => record.stars), [{ stars: { error: 'STARS_NOT_MIGRATED' } }])
})

test('star unlocks: GitHub\'s rate limit pauses reads for 15 minutes; an unreadable chain is one logged result', async () => {
  const [a, b] = [key(), key()]
  const starMarkets = [{ repoId: '700050', mint: a }, { repoId: '700051', mint: b }]
  const configs = { [a]: starConfigOf(a, { repoId: '700050' }), [b]: starConfigOf(b, { repoId: '700051' }) }
  let t = 0, limited = true
  const reads = [], run = setup({ markets: [], starMarkets, configs })
  const oracle = create(run, { clock: () => t, readStars: async id => { reads.push(id); if (limited) throw Error('GITHUB_RATE_LIMITED'); return 10 } })
  assert.deepEqual((await oracle.runOnce()).stars, [{ mint: a, error: 'GITHUB_RATE_LIMITED' }])
  t += 14 * 60_000
  assert.deepEqual(await oracle.runOnce(), { status: 'IDLE' }, 'paused: b waits too')
  limited = false
  t += 60_000
  assert.deepEqual((await oracle.runOnce()).stars.map(result => result.mint), [b, a], 'b, never read, goes first')
  assert.deepEqual(reads, ['700050', '700051', '700050'])
  const down = setup({ markets: [], starMarkets, configs }), logged = []
  down.connection.getMultipleAccountsInfo = async () => { throw Error('fetch failed') }
  const result = await create(down, { log: record => logged.push(record), readStars: async () => 10 }).runOnce()
  assert.deepEqual(result.stars, [{ error: 'STAR_CONFIGS_UNAVAILABLE' }])
  assert.deepEqual(logged, [{ stars: { error: 'STAR_CONFIGS_UNAVAILABLE' } }])
})
