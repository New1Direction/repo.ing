import test from 'node:test'
import assert from 'node:assert/strict'
import { AddressLookupTableAccount, ComputeBudgetProgram, Connection, Keypair, PACKET_DATA_SIZE, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  TransactionMessage, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { appModule, h, html } from './fixtures/render-jsx.mjs'
import { EARLY_ACCESS_LAUNCHES_READY, EARLY_ACCESS_NOT_TRADABLE, EARLY_ACCESS_WINDOWS, EarlyAccessError, isEarlyAccessMarket } from '../src/early-access.mjs'
import { EARLY_ACCESS_HOOK_PROGRAM_ID as HOOK, MAX_EARLY_ACCESS_SECONDS } from '../src/early-access-hook.mjs'
import { EARLY_ACCESS_CHAIN_MARGIN_SECONDS, UNREADABLE_SIGNED_LAUNCH, earlyAccessEnd, prepareVersionedLaunchSigning, readSignedVersionedLaunch } from '../src/early-access-launch.mjs'
import { assertEarlyAccessConfigTransaction, buildEarlyAccessConfigTransaction, earlyAccessLookupAddresses } from '../src/early-access-config.mjs'
import { CONTRIBUTOR_ERRORS, contributorsFromPage, fetchRepositoryContributors, resetContributorPause } from '../src/github-contributors.mjs'
import { EARLY_ACCESS_REFUSALS, contributorSnapshotStep, earlyAccessGuard, earlyAccessRequest } from '../app/lib/early-access-launch.mjs'
import { DefinitiveLaunchError, isVersionedLaunch, unsignedLaunchBase64 } from '../src/meteora-launch.mjs'
import { LIGHTHOUSE_PROGRAM, MAX_VERSIONED_LAUNCH_ASSERTIONS, matchesReviewedVersionedLaunch } from '../src/launch-wallet-assertions.mjs'
import { compiledLaunchInstructions, readLaunchComputeBudget, withVersionedLaunchPriorityFee } from '../src/launch-wallet-fees.mjs'
import { estimateLaunchCosts } from '../src/launch-costs.mjs'
import { createMarketConfigResolver } from '../src/market-config.mjs'
import { handleBuyGet } from '../app/lib/solana-actions.mjs'
import { decodeLaunchTransaction } from '../app/lib/launch-transaction.mjs'
import { POST as launchRoute } from '../app/api/launch/route.js'

const { LaunchForm } = await appModule('app/components/launch-form.jsx')
const WINDOWS = EARLY_ACCESS_WINDOWS.map(window => ({ ...window }))
const refusal = key => error => error instanceof EarlyAccessError && error.message === EARLY_ACCESS_REFUSALS[key]
const body = extra => ({ action: 'prepare', repoId: '1296269', repositoryUrl: 'https://github.com/octocat/Hello-World', tokenName: 'Hello',
  tokenSymbol: 'HELLO', tokenImage: 'data:image/png;base64,AA==', launcherWallet: Keypair.generate().publicKey.toBase58(), earlyAccessSeconds: 3600, ...extra })

test('the code gate stays closed in step 4: no launch offers or accepts early access', async () => {
  assert.equal(EARLY_ACCESS_LAUNCHES_READY, false)
  const saved = process.env.EARLY_ACCESS_ENABLED
  process.env.EARLY_ACCESS_ENABLED = 'true'
  try {
    assert.throws(() => earlyAccessRequest(body()), refusal('unavailable'))
    const response = await launchRoute(new Request('https://repo.ing/api/launch', { method: 'POST', body: JSON.stringify(body()) }))
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error, EARLY_ACCESS_REFUSALS.unavailable)
  } finally { if (saved === undefined) delete process.env.EARLY_ACCESS_ENABLED; else process.env.EARLY_ACCESS_ENABLED = saved }
})

test('a prepare request asks for early access only for a GitHub repository paired with SOL from its launch page, with a valid window', () => {
  const open = { launchable: true }
  assert.equal(earlyAccessRequest(body({ earlyAccessSeconds: undefined }), open), null)
  assert.equal(earlyAccessRequest(body({ earlyAccessSeconds: null }), { launchable: false }), null, 'not asked: nothing to refuse')
  assert.deepEqual(earlyAccessRequest(body(), open), { windowSeconds: 3600, rules: 1 })
  assert.deepEqual(earlyAccessRequest(body({ earlyAccessSeconds: '900', quoteAssetId: 'sol' }), open), { windowSeconds: 900, rules: 1 })
  assert.throws(() => earlyAccessRequest(body(), { launchable: false }), refusal('unavailable'))
  assert.throws(() => earlyAccessRequest(body({ repoId: '4503599627370497', hfId: 'abc' }), open), refusal('github'))
  assert.throws(() => earlyAccessRequest(body({ hfId: '65f0c0ffee' }), open), refusal('github'))
  assert.throws(() => earlyAccessRequest(body({ trendRevision: 3 }), open), refusal('launchPage'))
  assert.throws(() => earlyAccessRequest(body({ agentDraft: 'draft-token' }), open), refusal('launchPage'))
  assert.throws(() => earlyAccessRequest(body({ quoteAssetId: 'meta-xstock' }), open), refusal('sol'))
  for (const seconds of [899, 86_401, 0, -900, 1.5, '15m', '', true, {}]) {
    assert.throws(() => earlyAccessRequest(body({ earlyAccessSeconds: seconds }), open), /from 15 minutes to 24 hours/, JSON.stringify(seconds))
  }
})

test('the window end is wall time plus the window, never closer than 5 minutes to the program\'s 24-hour cap by chain time', () => {
  const wallNow = 1_800_000_000
  assert.equal(earlyAccessEnd({ windowSeconds: 3600, wallNow, chainNow: wallNow - 20 }), wallNow + 3600)
  // The chain's clock lags wall time by 10 minutes: a 24-hour window is cut to the cap less the margin.
  const lagging = wallNow - 600
  assert.equal(earlyAccessEnd({ windowSeconds: MAX_EARLY_ACCESS_SECONDS, wallNow, chainNow: lagging }),
    lagging + MAX_EARLY_ACCESS_SECONDS - EARLY_ACCESS_CHAIN_MARGIN_SECONDS)
  assert.equal(earlyAccessEnd({ windowSeconds: MAX_EARLY_ACCESS_SECONDS, wallNow, chainNow: wallNow }), wallNow + MAX_EARLY_ACCESS_SECONDS - 300)
  for (const windowSeconds of [900, 3600, 21_600, 86_400]) {
    for (const chainNow of [wallNow - 3600, wallNow - 30, wallNow, wallNow + 30]) {
      const end = earlyAccessEnd({ windowSeconds, wallNow, chainNow })
      assert.ok(end > chainNow && end - chainNow <= MAX_EARLY_ACCESS_SECONDS - EARLY_ACCESS_CHAIN_MARGIN_SECONDS, `${windowSeconds} ${chainNow}`)
    }
  }
  // A chain clock far ahead of ours would leave almost no window: refused, never sent.
  assert.throws(() => earlyAccessEnd({ windowSeconds: 900, wallNow, chainNow: wallNow + 900 }), /clock/)
  assert.throws(() => earlyAccessEnd({ windowSeconds: 900, wallNow, chainNow: null }), /clock/)
  assert.throws(() => earlyAccessEnd({ windowSeconds: 600, wallNow, chainNow: wallNow }), EarlyAccessError)
})

test('contributors: personal accounts with commits only; bots, organizations and anonymous entries are skipped', () => {
  assert.deepEqual(contributorsFromPage([{ login: 'alice', id: 1, type: 'User', contributions: 12 }, { login: 'dependabot[bot]', id: 2, type: 'Bot', contributions: 50 },
    { login: 'sneaky[bot]', id: 3, type: 'User', contributions: 5 }, { login: 'acme', id: 4, type: 'Organization', contributions: 1 },
    { email: 'a@b.c', name: 'A', type: 'Anonymous', contributions: 9 }, { login: 'zero', id: 5, type: 'User', contributions: 0 },
    { login: 'bad login', id: 6, type: 'User', contributions: 1 }, { login: 'big', id: 7, type: 'User', contributions: 3_000_000_000 }, null]),
  [{ githubUserId: '1', githubLogin: 'alice', contributions: 12 }, { githubUserId: '7', githubLogin: 'big', contributions: 2_147_483_647 }])
  assert.throws(() => contributorsFromPage({ message: 'nope' }), error => error.message === CONTRIBUTOR_ERRORS.unavailable)
})

test('contributors are read page by page from GitHub; failures, limits and an empty list are clear refusals', async () => {
  const page = (count, offset = 0) => Array.from({ length: count }, (_, i) => ({ login: `user${offset + i}`, id: offset + i + 1, type: 'User', contributions: 1 }))
  const reply = (status, json, headers = {}) => new Response(json === undefined ? null : JSON.stringify(json), { status,
    headers: { 'x-ratelimit-remaining': '4000', ...headers } })
  const read = async (replies, extra = {}) => {
    resetContributorPause()
    const urls = []
    const fetchImpl = async url => { urls.push(String(url)); const next = replies.shift(); if (next instanceof Error) throw next; return next }
    try { return { result: await fetchRepositoryContributors({ githubRepoId: '1296269', fullName: 'octocat/Hello-World', fetchImpl, headers: async () => ({}), ...extra }), urls } }
    catch (error) { return { error, urls } }
  }
  const two = await read([reply(200, page(100)), reply(200, page(20, 100))])
  assert.equal(two.result.length, 120)
  assert.deepEqual(two.urls, [1, 2].map(n => `https://api.github.com/repos/octocat/Hello-World/contributors?per_page=100&page=${n}`))
  const capped = await read(Array.from({ length: 6 }, (_, n) => reply(200, page(100, n * 100))))
  assert.deepEqual([capped.result.length, capped.urls.length], [500, 5], 'GitHub links at most 500 emails: five pages')
  assert.deepEqual((await read([reply(204)])).result, [], 'an empty repository')
  assert.equal((await read([reply(403, { message: 'The history or contributor list is too large to list contributors for this repository via the API.' })])).error.message,
    CONTRIBUTOR_ERRORS.tooLarge)
  for (const failure of [reply(429, {}, { 'retry-after': '30' }), reply(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' })]) {
    assert.equal((await read([failure])).error.message, CONTRIBUTOR_ERRORS.busy)
  }
  for (const failure of [reply(500, {}), reply(404, {}), new TypeError('fetch failed'), reply(200, { not: 'a list' })]) {
    assert.equal((await read([failure])).error.message, CONTRIBUTOR_ERRORS.unavailable)
  }
  // Under the reserve kept for the web's own reads: a complete first page is used, a list needing more pages is refused, and
  // nothing more is read until GitHub's reset.
  const low = { 'x-ratelimit-remaining': '700', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) }
  assert.equal((await read([reply(200, page(3), low)])).result.length, 3)
  const partial = await read([reply(200, page(100), low), reply(200, page(10, 100))])
  assert.deepEqual([partial.error.message, partial.urls.length], [CONTRIBUTOR_ERRORS.busy, 1])
  const urls = []
  await assert.rejects(fetchRepositoryContributors({ githubRepoId: '1296269', fullName: 'octocat/Hello-World', headers: async () => ({}),
    fetchImpl: async url => { urls.push(url); return reply(200, []) } }), error => error.message === CONTRIBUTOR_ERRORS.busy)
  assert.deepEqual(urls, [], 'paused')
  resetContributorPause()
  await assert.rejects(fetchRepositoryContributors({ githubRepoId: '1296269', fullName: 'octocat/../x', fetchImpl: async () => reply(200, []) }), /full name/)
})

test('the snapshot step: an empty list refuses the launch; the launcher stays listed only when its wallet is a linked contributor', async () => {
  const launcher = Keypair.generate().publicKey.toBase58(), other = Keypair.generate().publicKey.toBase58()
  const queries = []
  const client = { query: async (sql, values) => { queries.push([sql.trim().split(/\s+/)[0], values]); return { rows: [] } }, release() {} }
  const pool = { connect: async () => client, query: async (sql, values) => {
    queries.push(['links', values]); return { rows: [{ githubUserId: '1', githubLogin: 'alice', wallet: launcher, linkedAt: new Date(), updatedAt: new Date() }] } } }
  const repo = { githubRepoId: 1296269n, fullName: 'octocat/Hello-World' }
  const step = contributors => contributorSnapshotStep({ pool, fetchContributors: async () => contributors })
  await assert.rejects(step([])({ repo, wallet: launcher }), error => error.message === CONTRIBUTOR_ERRORS.none)
  assert.deepEqual(queries, [], 'nothing stored for an empty list')
  const alice = { githubUserId: '1', githubLogin: 'alice', contributions: 3 }, bob = { githubUserId: '2', githubLogin: 'bob', contributions: 1 }
  assert.deepEqual(await step([alice, bob])({ repo, wallet: launcher }), { contributors: 2, linkedWallets: 1, keepLauncher: true })
  assert.deepEqual(queries.map(([kind]) => kind), ['begin', 'delete', 'insert', 'commit', 'links'], 'replaced in one transaction')
  assert.deepEqual(queries[2][1], ['1296269', ['1', '2'], ['alice', 'bob'], [3, 1]])
  assert.equal((await step([alice, bob])({ repo, wallet: other })).keepLauncher, false)
  await assert.rejects(contributorSnapshotStep({ pool, fetchContributors: async () => { throw new EarlyAccessError(CONTRIBUTOR_ERRORS.busy, 503) } })({ repo, wallet: launcher }),
    error => error.message === CONTRIBUTOR_ERRORS.busy)
})

test('the guard: an early access market goes on only while early access can launch, on its hook and config; v0 only for it', async () => {
  const config = Keypair.generate().publicKey.toBase58()
  const stamped = { earlyAccessEnd: new Date(), transferHookProgram: HOOK.toBase58() }, plain = { earlyAccessEnd: null, transferHookProgram: null }
  const guard = (options = {}) => earlyAccessGuard(config, { launchable: () => true, configured: () => config, ...options })
  await guard()({ market: plain })
  await guard({ versioned: false })({ market: plain })
  await guard({ versioned: true })({ market: stamped })
  await assert.rejects(guard({ versioned: true })({ market: plain }), refusal('changed'))
  await assert.rejects(guard({ versioned: false })({ market: stamped }), refusal('changed'))
  await assert.rejects(guard({ launchable: () => false })({ market: stamped }), refusal('unavailable'))
  await assert.rejects(guard({ configured: () => null })({ market: stamped }), refusal('changed'))
  await assert.rejects(guard()({ market: { ...stamped, transferHookProgram: Keypair.generate().publicKey.toBase58() } }), refusal('changed'))
})

// A v0 launch-shaped fixture: the launcher pays, the creator and mint co-sign, one account comes from a lookup table.
function versionedFixture() {
  const launcher = Keypair.generate(), creator = Keypair.generate(), mint = Keypair.generate(), shared = Keypair.generate().publicKey
  const table = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: 18446744073709551615n, lastExtendedSlot: 1,
    lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [shared, HOOK] } })
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
    SystemProgram.createAccount({ fromPubkey: launcher.publicKey, newAccountPubkey: mint.publicKey, lamports: 1, space: 0, programId: SystemProgram.programId }),
    new TransactionInstruction({ programId: SystemProgram.programId, data: Buffer.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
      keys: [{ pubkey: creator.publicKey, isSigner: true, isWritable: true }, { pubkey: shared, isSigner: false, isWritable: true },
        { pubkey: HOOK, isSigner: false, isWritable: false }] })]
  const blockhash = Keypair.generate().publicKey.toBase58()
  const compile = (list, { tables = [table], recentBlockhash = blockhash } = {}) => new VersionedTransaction(new TransactionMessage({ payerKey: launcher.publicKey,
    recentBlockhash, instructions: list }).compileToV0Message(tables))
  const tx = compile(instructions)
  return { launcher, creator, mint, table, instructions, compile, tx, loadTables: async () => [table],
    sign: prepareVersionedLaunchSigning(tx, launcher.publicKey, creator, mint, async () => [table]) }
}
const lighthouse = (key, data = Buffer.from([2, 1, 0, 0]), extra = []) => new TransactionInstruction({ programId: new PublicKey(LIGHTHOUSE_PROGRAM),
  keys: [{ pubkey: key, isSigner: false, isWritable: false }, ...extra], data })

// The same message with its header changed (signer and writable counts), the rest of the bytes as they were.
const withHeader = (tx, change) => {
  const message = VersionedMessage.deserialize(tx.message.serialize())
  message.header = change(message.header)
  return new VersionedTransaction(message)
}

test('v0 review: the reviewed message, or it with trailing Lighthouse assertions, is co-signed; anything else is refused', async () => {
  const f = versionedFixture(), reviewed = Buffer.from(f.tx.message.serialize())
  const otherTable = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: f.table.state })
  const bySigner = (tx, signer) => { tx.sign([signer]); return tx }
  assert.equal(await matchesReviewedVersionedLaunch(reviewed, VersionedTransaction.deserialize(f.tx.serialize()), f.loadTables), true)
  const asserted = f.compile([...f.instructions, lighthouse(f.mint.publicKey)])
  assert.equal(await matchesReviewedVersionedLaunch(reviewed, asserted, f.loadTables, { maxAssertions: 1 }), true, 'a trailing Lighthouse assertion')
  for (const [label, changed] of [
    ['a changed instruction', f.compile([...f.instructions.slice(0, 2), SystemProgram.createAccount({ fromPubkey: f.launcher.publicKey,
      newAccountPubkey: f.mint.publicKey, lamports: 2, space: 0, programId: SystemProgram.programId }), f.instructions[3]])],
    ['a dropped instruction', f.compile(f.instructions.slice(0, 3))],
    ['an assertion that makes an account writable', f.compile([...f.instructions, new TransactionInstruction({ ...lighthouse(HOOK), keys: [{ pubkey: HOOK, isSigner: false, isWritable: true }] })])],
    ['an assertion on a new account', f.compile([...f.instructions, lighthouse(Keypair.generate().publicKey)])],
    ['an appended transfer', f.compile([...f.instructions, SystemProgram.transfer({ fromPubkey: f.launcher.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })])],
    ['more assertions than fit', f.compile([...f.instructions, ...Array.from({ length: MAX_VERSIONED_LAUNCH_ASSERTIONS + 1 }, () => lighthouse(f.mint.publicKey))])],
    ['no lookup table', new VersionedTransaction(new TransactionMessage({ payerKey: f.launcher.publicKey, recentBlockhash: f.tx.message.recentBlockhash,
      instructions: f.instructions }).compileToV0Message([]))],
    ['another lookup table with the same addresses', f.compile(f.instructions, { tables: [otherTable] })],
    ['another lookup table, with an assertion', f.compile([...f.instructions, lighthouse(f.mint.publicKey)], { tables: [otherTable] })],
    ['another blockhash', f.compile(f.instructions, { recentBlockhash: Keypair.generate().publicKey.toBase58() })],
    ['another blockhash, with an assertion', f.compile([...f.instructions, lighthouse(f.mint.publicKey)], { recentBlockhash: Keypair.generate().publicKey.toBase58() })],
    ['a header that makes an account writable', withHeader(f.tx, header => ({ ...header, numReadonlyUnsignedAccounts: header.numReadonlyUnsignedAccounts - 1 }))],
    ['a header that makes an account a signer', withHeader(f.tx, header => ({ ...header, numRequiredSignatures: header.numRequiredSignatures + 1 }))],
    ['a header change beside an assertion', withHeader(f.compile([...f.instructions, lighthouse(f.mint.publicKey)]),
      header => ({ ...header, numReadonlyUnsignedAccounts: header.numReadonlyUnsignedAccounts - 1 }))],
    ['a two-account Lighthouse instruction', f.compile([...f.instructions, lighthouse(f.mint.publicKey, undefined, [{ pubkey: f.launcher.publicKey, isSigner: false, isWritable: false }])])],
    ['a Lighthouse memory write', f.compile([...f.instructions, lighthouse(f.mint.publicKey, Buffer.from([0, 0, 0, 0]))])],
    ['a Lighthouse memory close', f.compile([...f.instructions, lighthouse(f.mint.publicKey, Buffer.from([1, 0, 0, 0]))])],
    ['an unknown Lighthouse variant', f.compile([...f.instructions, lighthouse(f.mint.publicKey, Buffer.from([42, 0, 0, 0]))])],
    ['an assertion too short to be one', f.compile([...f.instructions, lighthouse(f.mint.publicKey, Buffer.from([2, 0]))])],
  ]) assert.equal(await matchesReviewedVersionedLaunch(reviewed, changed, f.loadTables), false, label)
  const allowed = f.compile([...f.instructions, ...Array.from({ length: MAX_VERSIONED_LAUNCH_ASSERTIONS }, () => lighthouse(f.mint.publicKey))])
  assert.equal(await matchesReviewedVersionedLaunch(reviewed, allowed, f.loadTables), MAX_VERSIONED_LAUNCH_ASSERTIONS > 0, 'as many as fit')
  // Never a transaction too large to send, whatever the count allowed (web3.js cannot even encode one).
  const oversized = f.compile([...f.instructions, ...Array.from({ length: 5 }, () => lighthouse(f.mint.publicKey, Buffer.from([2, ...Buffer.alloc(249)])))])
  assert.throws(() => oversized.serialize(), /overruns/)
  assert.equal(await matchesReviewedVersionedLaunch(reviewed, oversized, f.loadTables, { maxAssertions: 5 }), false, 'over 1,232 bytes')
  const nearLimit = f.compile([...f.instructions, ...Array.from({ length: 3 }, () => lighthouse(f.mint.publicKey, Buffer.from([2, ...Buffer.alloc(200)])))])
  assert.ok(nearLimit.serialize().length <= PACKET_DATA_SIZE)
  assert.equal(await matchesReviewedVersionedLaunch(reviewed, nearLimit, f.loadTables, { maxAssertions: 3 }), true, 'within the limit, as many as allowed')
  assert.equal(await matchesReviewedVersionedLaunch(reviewed, new Transaction(), f.loadTables), false, 'a legacy transaction')

  // Co-signing: the wallet signs first; the creator and the mint sign the returned message; the launch signature is the payer's.
  const signed = await f.sign(async tx => bySigner(VersionedTransaction.deserialize(tx.serialize()), f.launcher))
  const landed = VersionedTransaction.deserialize(signed.raw)
  assert.equal(landed.signatures.filter(signature => signature.some(byte => byte !== 0)).length, 3)
  if (MAX_VERSIONED_LAUNCH_ASSERTIONS > 0) {
    const g = versionedFixture()
    const withAssertion = await g.sign(async () => bySigner(g.compile([...g.instructions, lighthouse(g.mint.publicKey)]), g.launcher))
    assert.equal(VersionedTransaction.deserialize(withAssertion.raw).message.compiledInstructions.length, 5)
  }
  // Anything but a v0 transaction back from the wallet (or the page) is refused with a message the page can show.
  await assert.rejects(versionedFixture().sign(async () => new Transaction()), error => error instanceof DefinitiveLaunchError && error.message === UNREADABLE_SIGNED_LAUNCH)
  await assert.rejects(versionedFixture().sign(async () => null), error => error.message === UNREADABLE_SIGNED_LAUNCH)
  const h = versionedFixture()
  await assert.rejects(h.sign(async tx => bySigner(h.compile(h.instructions.slice(0, 3)), h.launcher)), DefinitiveLaunchError)
  await assert.rejects(versionedFixture().sign(async tx => VersionedTransaction.deserialize(tx.serialize())), /Launcher signature missing/)
  const i = versionedFixture()
  await assert.rejects(i.sign(async tx => bySigner(VersionedTransaction.deserialize(tx.serialize()), Keypair.generate())), /signer|Launcher signature/i)
})

test('a v0 launch keeps the launch budget rules; its costs and its bytes travel like a legacy review', async () => {
  const f = versionedFixture()
  const probes = []
  const connection = { rpcEndpoint: 'http://127.0.0.1:8899', getRecentPrioritizationFees: async () => [],
    simulateTransaction: async tx => { probes.push(tx); return { value: { err: null, unitsConsumed: 205_000, accounts: [{ lamports: 9_000_000_000 - 120_000_000 }] } } },
    getBalanceAndContext: async () => ({ context: { slot: 5 }, value: 9_000_000_000 }), getFeeForMessage: async () => ({ value: 15_000 + 50_000 }) }
  const { transaction, computeUnitLimit } = await withVersionedLaunchPriorityFee(connection, f.instructions.slice(2),
    { feePayer: f.launcher.publicKey, blockhash: f.tx.message.recentBlockhash, lookupTables: [f.table], log: () => {} })
  assert.ok(probes[0] instanceof VersionedTransaction && probes[0].version === 0, 'the probe is the v0 transaction at the ceiling')
  assert.equal(computeUnitLimit, 246_000)
  const budget = readLaunchComputeBudget(compiledLaunchInstructions(transaction.message))
  assert.equal(budget.limit, 246_000)
  await assert.rejects(withVersionedLaunchPriorityFee(connection, f.instructions, { feePayer: f.launcher.publicKey, blockhash: f.tx.message.recentBlockhash,
    lookupTables: [f.table] }), /set exactly once/)
  const costs = await estimateLaunchCosts({ ...connection, getFeeForMessage: async () => ({ value: 15_000 + Number(budget.priorityFee) }) }, transaction, '100000000')
  assert.equal(costs.total, '120000000')
  assert.equal(costs.priorityFee, budget.priorityFee.toString())
  // Serialized for the page and read back as v0; a legacy review is serialized exactly as before.
  const base64 = unsignedLaunchBase64(transaction)
  assert.equal(isVersionedLaunch(base64), true)
  const web3 = await import('@solana/web3.js')
  assert.ok(decodeLaunchTransaction(Buffer.from(base64, 'base64'), web3) instanceof VersionedTransaction)
  const legacy = new Transaction({ feePayer: f.launcher.publicKey, recentBlockhash: f.tx.message.recentBlockhash }).add(f.instructions[2])
  assert.equal(unsignedLaunchBase64(legacy), legacy.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'))
  assert.equal(isVersionedLaunch(unsignedLaunchBase64(legacy)), false)
  assert.ok(decodeLaunchTransaction(legacy.serialize({ requireAllSignatures: false, verifySignatures: false }), web3) instanceof Transaction)
})

test('the early access config transaction is exactly the expected accounts and the early access curve', async () => {
  const connection = new Connection('http://127.0.0.1:1')
  const [config, partner, leftoverReceiver] = [1, 2, 3].map(() => Keypair.generate().publicKey.toBase58())
  const built = await buildEarlyAccessConfigTransaction({ connection, config, partner, leftoverReceiver })
  const coder = new DynamicBondingCurveClient(connection, 'confirmed').state.getProgram().coder
  const expected = { coder, config, partner, leftoverReceiver }
  assert.equal(assertEarlyAccessConfigTransaction(built.tx, expected), true)
  assert.match(built.instructionSha256, /^[0-9a-f]{64}$/)
  assert.throws(() => assertEarlyAccessConfigTransaction(built.tx, { ...expected, partner: leftoverReceiver }), /accounts differ/)
  assert.throws(() => assertEarlyAccessConfigTransaction(built.tx, { ...expected, hookProgram: Keypair.generate().publicKey }), /accounts differ/)
  assert.throws(() => assertEarlyAccessConfigTransaction(built.tx, { ...expected, curve: { ...built.curve, migrationQuoteThreshold: 86 } }),
    /differ from the early access curve in: migrationQuoteThreshold/)
  const ix = built.tx.instructions[0]
  const flipped = new Transaction().add(new TransactionInstruction({ ...ix, data: Buffer.from(ix.data.map((byte, i) => i === ix.data.length - 40 ? byte ^ 1 : byte)) }))
  assert.throws(() => assertEarlyAccessConfigTransaction(flipped, expected), /differ from the early access curve|padding/)
  assert.throws(() => assertEarlyAccessConfigTransaction(new Transaction().add(ix, ix), expected), /shape/)
  // The lookup table holds the twelve shared keys, the config last.
  const addresses = earlyAccessLookupAddresses(config).map(String)
  assert.equal(addresses.length, 12)
  assert.equal(new Set(addresses).size, 12)
  assert.deepEqual(addresses.slice(-3), [HOOK.toBase58(), (await import('../src/early-access-hook.mjs')).platformAddress().toBase58(), config])
})

test('until step 5 an early access market is refused by SOL paths and Blinks, never read as a SOL market', async () => {
  const market = { mint: Keypair.generate().publicKey.toBase58(), pool: Keypair.generate().publicKey.toBase58(), earlyAccessEnd: new Date(),
    transferHookProgram: HOOK.toBase58() }
  assert.equal(isEarlyAccessMarket(market), true)
  assert.equal(isEarlyAccessMarket({ earlyAccessEnd: null, transferHookProgram: null }), false)
  assert.throws(() => createMarketConfigResolver(Keypair.generate().publicKey.toBase58(), [])(market), /Contributor early access market needs a transfer-hook-aware path/)
  const get = await handleBuyGet(market.mint, { loadMarket: async () => ({ repoId: '1', mint: market.mint, symbol: 'X', fullName: 'o/n', description: null,
    quoteMint: null, earlyAccessEnd: new Date() }) })
  assert.equal(get.status, 404)
  assert.equal((await get.json()).message, EARLY_ACCESS_NOT_TRADABLE)
})

test('the launch form offers early access only when it can launch, for a GitHub repository paired with SOL from its launch page', () => {
  const repo = { repoId: '1296269', owner: 'octocat', name: 'Hello-World', fullName: 'octocat/Hello-World', source: 'github' }
  const render = props => html(h(LaunchForm, { repo, available: true, quoteOptions: null, ...props }), { wallet: true })
  assert.doesNotMatch(render({}), /Contributor early access/, 'switched off: not offered')
  const offered = render({ earlyAccess: { windows: WINDOWS } })
  assert.match(offered, /<legend class="field-label">Contributor early access/)
  for (const window of WINDOWS) assert.match(offered, new RegExp(`>${window.label}</button>`))
  assert.match(offered, /aria-pressed="true"[^>]*>Off<\/button>/)
  assert.match(offered, /only this repository&#x27;s contributors buy first\. Anyone can sell at any time\./)
  assert.match(offered, /href="\/contributors\/link"/)
  assert.doesNotMatch(render({ earlyAccess: { windows: WINDOWS }, trendRevision: 4 }), /Contributor early access/, 'not on a trend launch')
  assert.doesNotMatch(render({ earlyAccess: { windows: WINDOWS }, draft: { token: 't', tokenName: 'A', tokenSymbol: 'A' } }), /Contributor early access/, 'not on an agent draft')
  assert.doesNotMatch(render({ earlyAccess: { windows: WINDOWS }, repo: { ...repo, source: 'huggingface', hfId: 'x' } }), /Contributor early access/, 'not for a model')
})

test('the signed v0 launch the page posts back is read only as v0; anything else is a message the page can show', () => {
  const f = versionedFixture()
  const legacy = new Transaction({ feePayer: f.launcher.publicKey, recentBlockhash: f.tx.message.recentBlockhash })
    .add(SystemProgram.transfer({ fromPubkey: f.launcher.publicKey, toPubkey: f.mint.publicKey, lamports: 1 }))
  for (const body of [undefined, null, 42, '', 'not base64 at all!', Buffer.from([1, 2, 3]).toString('base64'),
    legacy.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')]) {
    assert.throws(() => readSignedVersionedLaunch(body), error => error instanceof DefinitiveLaunchError && error.message === UNREADABLE_SIGNED_LAUNCH, String(body))
  }
  const v0 = Buffer.from(f.tx.serialize()).toString('base64')
  assert.equal(readSignedVersionedLaunch(v0).version, 0)
})

// The fair ramp and star unlocks (owner decisions 2026-10-06 and 2026-10-07): options of an early access launch only, star unlocks
// with the fair ramp only, each exactly true (false or absent: off).
test('the fair ramp and star unlocks are options of an early access launch only', () => {
  const open = { launchable: true }
  assert.deepEqual(earlyAccessRequest(body({ fairRamp: true }), open), { windowSeconds: 3600, rules: 3 })
  assert.deepEqual(earlyAccessRequest(body({ fairRamp: true, starUnlocks: true }), open), { windowSeconds: 3600, rules: 7 })
  assert.deepEqual(earlyAccessRequest(body({ fairRamp: false, starUnlocks: false }), open), { windowSeconds: 3600, rules: 1 })
  assert.throws(() => earlyAccessRequest(body({ starUnlocks: true }), open), refusal('stars'))
  for (const extra of [{ earlyAccessSeconds: undefined, fairRamp: true }, { earlyAccessSeconds: null, starUnlocks: true, fairRamp: true },
    { fairRamp: 'yes' }, { fairRamp: 1 }, { starUnlocks: 'true', fairRamp: true }]) {
    assert.throws(() => earlyAccessRequest(body(extra), open), refusal('options'), JSON.stringify(extra))
  }
})
