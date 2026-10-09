import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import bs58 from 'bs58'
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { STATUS } from '../src/bundle-vault.mjs'
import { AGENT, BUNDLE_STALE_OPENING_MS, bundleAction, bundleJobSettings, createBundleJobs, readSecretKey, vaultAgentDecision,
  vaultTradeMinimumOut } from '../src/bundle-jobs.mjs'

const NOW = 1_800_000_000
const key = () => Keypair.generate().publicKey
const chain = (overrides = {}) => ({ status: STATUS.RAISING, raised: 5_000_000_000n, target: 5_000_000_000n, released: 0n, deadline: NOW + 3_600,
  launchGraceSecs: 86_400, vaultSol: PublicKey.default, ...overrides })
const row = (status, overrides = {}) => ({ status, createdAt: new Date((NOW - 60) * 1000), ...overrides })

test('the bundles table follows the chain: opening, raising, launching, launched', () => {
  assert.deepEqual(bundleAction({ row: row('opening'), chain: chain(), market: null, now: NOW }), { action: 'activate' })
  assert.deepEqual(bundleAction({ row: row('opening'), chain: null, market: null, now: NOW }), { action: 'wait' })
  assert.deepEqual(bundleAction({ row: row('opening', { createdAt: new Date(NOW * 1000 - BUNDLE_STALE_OPENING_MS - 1) }), chain: null, market: null, now: NOW }),
    { action: 'expire' }, 'a create transaction that never landed frees the repository')
  assert.deepEqual(bundleAction({ row: row('raising'), chain: chain({ status: STATUS.FAILED }), market: null, now: NOW }), { action: 'mark_failed' })
  assert.deepEqual(bundleAction({ row: row('raising'), chain: chain({ status: STATUS.LAUNCHED }), market: { status: 'confirmed' }, now: NOW }), { action: 'mark_launched' })
  assert.deepEqual(bundleAction({ row: row('launching'), chain: chain({ status: STATUS.LAUNCHED }), market: { status: 'confirmed' }, now: NOW }), { action: 'mark_launched' })
  assert.deepEqual(bundleAction({ row: row('launching'), chain: chain(), market: { status: 'ambiguous' }, now: NOW }), { action: 'wait' }, 'an attempt that may have landed is left to the indexer')
  assert.deepEqual(bundleAction({ row: row('launching'), chain: chain(), market: { status: 'failed' }, now: NOW }), { action: 'retry_launch' })
  assert.deepEqual(bundleAction({ row: row('launched'), chain: chain({ status: STATUS.LAUNCHED }), market: { status: 'confirmed' }, now: NOW }), { action: 'open_vault' })
  assert.deepEqual(bundleAction({ row: row('launched'), chain: chain({ status: STATUS.LAUNCHED, vaultSol: key() }), market: { status: 'confirmed' }, now: NOW }), { action: 'tend' })
})

test('a full raise launches until its grace period ends; a raise past its deadline or grace fails', () => {
  assert.deepEqual(bundleAction({ row: row('raising'), chain: chain(), market: null, now: NOW }), { action: 'launch' })
  assert.deepEqual(bundleAction({ row: row('raising'), chain: chain({ deadline: NOW - 10 }), market: null, now: NOW }), { action: 'launch' }, 'full: launchable after the deadline')
  assert.deepEqual(bundleAction({ row: row('raising'), chain: chain({ deadline: NOW - 86_401 }), market: null, now: NOW }), { action: 'fail_raise' }, 'full but stale')
  assert.deepEqual(bundleAction({ row: row('raising'), chain: chain({ raised: 1n }), market: null, now: NOW }), { action: 'wait' }, 'still raising')
  assert.deepEqual(bundleAction({ row: row('raising'), chain: chain({ raised: 1n, deadline: NOW - 1 }), market: null, now: NOW }), { action: 'fail_raise' })
  assert.deepEqual(bundleAction({ row: row('raising'), chain: chain({ released: 1n }), market: null, now: NOW }), { action: 'wait' }, 'never a second release')
})

test('a launch that cannot land fails its raise once the grace period ends, so backers get refunds', () => {
  const stale = chain({ deadline: NOW - 86_401 })
  // Whatever the attempt was left in (a repeating refusal, or a crash between reserve and send), the program refuses release now.
  for (const market of [null, { status: 'failed' }, { status: 'reserved' }, { status: 'prepared' }, { status: 'ambiguous' }]) {
    assert.deepEqual(bundleAction({ row: row('launching'), chain: stale, market, now: NOW }), { action: 'fail_raise' }, JSON.stringify(market))
  }
  // Within the grace period it keeps retrying, or waits for an attempt that may have landed.
  assert.deepEqual(bundleAction({ row: row('launching'), chain: chain({ deadline: NOW - 86_399 }), market: null, now: NOW }), { action: 'retry_launch' })
  assert.deepEqual(bundleAction({ row: row('launching'), chain: chain({ deadline: NOW - 86_399 }), market: { status: 'prepared' }, now: NOW }), { action: 'wait' })
  // Released (it landed) or already failed: never a fail_raise.
  assert.notDeepEqual(bundleAction({ row: row('launching'), chain: chain({ deadline: NOW - 86_401, released: 1n }), market: null, now: NOW }), { action: 'fail_raise' })
  assert.deepEqual(bundleAction({ row: row('launching'), chain: chain({ deadline: NOW - 86_401, status: STATUS.FAILED }), market: null, now: NOW }), { action: 'mark_failed' })
})

test('the bundle jobs send only through a confirmed connection, and the worker gives them one', () => {
  const settings = { config: key(), lookupTable: key().toBase58(), launchSigner: Keypair.generate(), creator: Keypair.generate(), operator: null,
    agentsLive: false, metadataOrigin: 'https://repo.ing' }
  // A finalized connection preflights a fresh confirmed blockhash at finalized and refuses it ("Blockhash not found").
  assert.throws(() => createBundleJobs({ pool: {}, connection: new Connection('http://127.0.0.1:1', 'finalized'), settings }), /confirmed commitment/)
  assert.doesNotThrow(() => createBundleJobs({ pool: {}, connection: new Connection('http://127.0.0.1:1', 'confirmed'), settings }))
  const worker = readFileSync(new URL('../scripts/run-worker.mjs', import.meta.url), 'utf8')
  assert.match(worker, /createBundleJobs\(\{ pool, connection: rpcConnection\(rpc, 'confirmed'\), settings: bundleSettings,/)
  assert.match(readFileSync(new URL('../src/bundle-jobs.mjs', import.meta.url), 'utf8'), /sendRawTransaction\(tx\.serialize\(\), \{ preflightCommitment: 'confirmed' \}\)/)
})

test('with launches off, a full raise waits and fails after its grace period (refunds open); everything else still moves', () => {
  const off = args => bundleAction({ ...args, launchesOn: false })
  assert.deepEqual(off({ row: row('raising'), chain: chain(), market: null, now: NOW }), { action: 'wait', reason: 'Bundle launches are off' })
  assert.deepEqual(off({ row: row('launching'), chain: chain({ deadline: NOW - 10 }), market: { status: 'failed' }, now: NOW }),
    { action: 'wait', reason: 'Bundle launches are off' })
  assert.deepEqual(off({ row: row('raising'), chain: chain({ deadline: NOW - 86_401 }), market: null, now: NOW }), { action: 'fail_raise' })
  assert.deepEqual(off({ row: row('launching'), chain: chain({ deadline: NOW - 86_401 }), market: { status: 'failed' }, now: NOW }), { action: 'fail_raise' })
  assert.deepEqual(off({ row: row('raising'), chain: chain({ raised: 1n, deadline: NOW - 1 }), market: null, now: NOW }), { action: 'fail_raise' })
  assert.deepEqual(off({ row: row('raising'), chain: chain({ status: STATUS.FAILED }), market: null, now: NOW }), { action: 'mark_failed' })
  assert.deepEqual(off({ row: row('opening'), chain: chain(), market: null, now: NOW }), { action: 'activate' })
  assert.deepEqual(off({ row: row('launched'), chain: chain({ status: STATUS.LAUNCHED }), market: { status: 'confirmed' }, now: NOW }), { action: 'open_vault' })
  assert.deepEqual(off({ row: row('launched'), chain: chain({ status: STATUS.LAUNCHED, vaultSol: key() }), market: { status: 'confirmed' }, now: NOW }), { action: 'tend' })
})

const launched = (overrides = {}) => ({ status: STATUS.LAUNCHED, paused: false, tradingOpensAt: NOW - 1, vaultSol: key(), day: Math.floor(NOW / 86_400),
  dayBought: 0n, daySold: 0n, lastBuyAt: 0, lastSellAt: 0, costLamports: 19_000_000_000n, costTokens: 400_000_000_000_000n,
  policy: { maxTradeBps: 200, maxDailyBuyBps: 1_000, maxDailySellBps: 100, floorBps: 10_000, gapSecs: 600 }, ...overrides })
const cost = 19_000_000_000 / 400_000_000_000_000

test('the vault agent sells above its target and buys after a fall, within every limit the program checks', () => {
  const sell = vaultAgentDecision({ bundle: launched(), price: 2 * cost, high: 2 * cost, vaultSol: 0n, vaultTokens: 400_000_000_000_000n, now: NOW })
  // 2% per trade, but at most 1% of the tokens a day: 1%.
  assert.deepEqual([sell.buy, sell.amountIn], [false, 4_000_000_000_000n])
  assert.equal(vaultAgentDecision({ bundle: launched({ daySold: 4_000_000_000_000n }), price: 2 * cost, high: 2 * cost, vaultSol: 0n,
    vaultTokens: 396_000_000_000_000n, now: NOW }), null, 'the day\'s sells are used up')
  assert.equal(vaultAgentDecision({ bundle: launched(), price: AGENT.sellAtCost * cost * 0.99, high: 0, vaultSol: 0n, vaultTokens: 1n, now: NOW }), null,
    'below the sell target')
  const buy = vaultAgentDecision({ bundle: launched(), price: cost, high: cost / (1 - AGENT.buyAfterFall) + 1e-15, vaultSol: 1_000_000_000n, vaultTokens: 0n, now: NOW })
  assert.deepEqual([buy.buy, buy.amountIn], [true, 20_000_000n], '2% of the SOL (the day allows 10%)')
  assert.equal(vaultAgentDecision({ bundle: launched({ lastSellAt: NOW - 10 }), price: cost, high: 2 * cost, vaultSol: 1_000_000_000n, vaultTokens: 0n, now: NOW }),
    null, 'not right after a sell')
  for (const bundle of [launched({ paused: true }), launched({ tradingOpensAt: NOW + 1 }), launched({ vaultSol: PublicKey.default }), launched({ status: STATUS.RAISING })]) {
    assert.equal(vaultAgentDecision({ bundle, price: 2 * cost, high: 2 * cost, vaultSol: 1n, vaultTokens: 1_000_000n, now: NOW }), null)
  }
  // A new UTC day starts the day's limits over.
  const nextDay = vaultAgentDecision({ bundle: launched({ day: Math.floor(NOW / 86_400) - 1, daySold: 4_000_000_000_000n }), price: 2 * cost, high: 2 * cost,
    vaultSol: 0n, vaultTokens: 396_000_000_000_000n, now: NOW })
  assert.equal(nextDay.amountIn, 3_960_000_000_000n)
})

test('settings: dark returns null; missing pieces are named, never their values; keys read as base58 or a JSON array', () => {
  assert.equal(bundleJobSettings({}), null)
  assert.equal(bundleJobSettings({ BUNDLE_LAUNCHES_ENABLED: 'false' }), null, 'the switch is off')
  assert.deepEqual(bundleJobSettings({ BUNDLE_LAUNCHES_ENABLED: 'true', BUNDLE_DBC_CONFIG: ' ', BUNDLE_LAUNCH_SIGNER_SECRET_KEY: 'x' }),
    { missing: ['BUNDLE_DBC_CONFIG', 'BUNDLE_LOOKUP_TABLE', 'PLATFORM_CREATOR_SECRET_KEY', 'APP_ORIGIN'] })
  // APP_ORIGIN is each bundle token's metadata URI base: required, and reduced to an origin.
  const keys = { BUNDLE_LAUNCHES_ENABLED: 'true', BUNDLE_DBC_CONFIG: key().toBase58(), BUNDLE_LOOKUP_TABLE: key().toBase58(),
    BUNDLE_LAUNCH_SIGNER_SECRET_KEY: bs58.encode(Keypair.generate().secretKey), PLATFORM_CREATOR_SECRET_KEY: bs58.encode(Keypair.generate().secretKey) }
  assert.equal(bundleJobSettings({ ...keys, APP_ORIGIN: 'https://repo.ing/' }).metadataOrigin, 'https://repo.ing')
  assert.equal(bundleJobSettings({ ...keys, APP_ORIGIN: ' https://repo.ing/some/path ' }).metadataOrigin, 'https://repo.ing')
  assert.throws(() => bundleJobSettings({ ...keys, APP_ORIGIN: 'repo.ing' }))
  // Configured but switched off: the jobs still run for existing bundles, with launches off.
  assert.equal(bundleJobSettings({ ...keys, APP_ORIGIN: 'https://repo.ing' }).launchesOn, true)
  const off = bundleJobSettings({ ...keys, BUNDLE_LAUNCHES_ENABLED: 'false', APP_ORIGIN: 'https://repo.ing' })
  assert.deepEqual([off.launchesOn, off.config.toBase58()], [false, keys.BUNDLE_DBC_CONFIG])
  assert.deepEqual(bundleJobSettings({ BUNDLE_DBC_CONFIG: keys.BUNDLE_DBC_CONFIG }).missing,
    ['BUNDLE_LOOKUP_TABLE', 'BUNDLE_LAUNCH_SIGNER_SECRET_KEY', 'PLATFORM_CREATOR_SECRET_KEY', 'APP_ORIGIN'], 'configured halfway: named, even when off')
  const pair = Keypair.generate()
  assert.ok(readSecretKey(bs58.encode(pair.secretKey)).publicKey.equals(pair.publicKey))
  assert.ok(readSecretKey(JSON.stringify([...pair.secretKey])).publicKey.equals(pair.publicKey))
  assert.equal(readSecretKey(''), null)
  assert.throws(() => readSecretKey('not a key'))
})

// The confirmed clock sysvar the quotes read (src/chain-clock.mjs): slot at 0, unix time at 32.
function clockConnection({ slot = 400_000_000n, time = 1_800_000_000n } = {}) {
  const data = Buffer.alloc(40); data.writeBigUInt64LE(slot, 0); data.writeBigInt64LE(time, 32)
  return { async getAccountInfo(address) { return address.equals(SYSVAR_CLOCK_PUBKEY) ? { owner: new PublicKey('Sysvar1111111111111111111111111111111111111'), data } : null } }
}

test('a vault trade\'s minimum is the exact curve quote less 1%, quoted at the chain clock (never before activation)', async () => {
  const calls = [], curveConfig = key(), curve = { poolState: { activationPoint: new BN(400_000_100) } }
  const dbc = { connection: { rpcEndpoint: `fake-${randomUUID()}` }, commitment: 'confirmed',
    state: { async getPoolConfig(address) { assert.ok(new PublicKey(address).equals(curveConfig)); return { activationType: 0 } } },
    pool: { swapQuote(params) { calls.push(params); return { outputAmount: new BN(1_000_000), minimumAmountOut: new BN(990_000) } } } }
  const sell = await vaultTradeMinimumOut({ connection: clockConnection(), dbc, curveConfig, curve, damm: null, buy: false, amountIn: 5_000n })
  assert.equal(sell, 990_000n)
  assert.equal(AGENT.slippageBps, 100)
  const [params] = calls
  assert.deepEqual([params.swapBaseForQuote, params.amountIn.toString(), params.slippageBps, params.hasReferral, params.eligibleForFirstSwapWithMinFee],
    [true, '5000', 100, false, false])
  assert.equal(params.virtualPool, curve, 'the SDK gets getPool\'s own answer')
  assert.equal(params.currentPoint.toString(), '400000100', 'a clock behind the pool\'s activation is clamped to it')
  await vaultTradeMinimumOut({ connection: clockConnection({ slot: 400_000_500n }), dbc, curveConfig, curve, damm: null, buy: true, amountIn: 7n })
  assert.deepEqual([calls[1].swapBaseForQuote, calls[1].currentPoint.toString()], [false, '400000500'])
  // An SDK minimum that disagrees with the independent floor is no quote.
  dbc.pool.swapQuote = () => ({ outputAmount: new BN(1_000_000), minimumAmountOut: new BN(1) })
  await assert.rejects(vaultTradeMinimumOut({ connection: clockConnection(), dbc, curveConfig, curve, damm: null, buy: false, amountIn: 5n }), /No executable output/)
})

test('after graduation the minimum is the exact DAMM v2 quote less 1%', async () => {
  const calls = [], tokenAMint = key()
  const amm = { getQuote2(params) { calls.push(params); const out = params.inputTokenMint.equals(NATIVE_MINT) ? 2_000_000n : 3_000_000n
    return { outputAmount: new BN(String(out)), minimumAmountOut: new BN(String(out * 9_900n / 10_000n)), amountLeft: new BN(0),
      claimingFee: new BN(0), compoundingFee: new BN(0), protocolFee: new BN(0), referralFee: new BN(0) } } }
  const damm = { activationType: 1, tokenAMint }
  assert.equal(await vaultTradeMinimumOut({ connection: clockConnection(), amm, damm, buy: true, amountIn: 1_000n }), 1_980_000n)
  assert.equal(await vaultTradeMinimumOut({ connection: clockConnection(), amm, damm, buy: false, amountIn: 1_000n }), 2_970_000n)
  assert.ok(calls[0].inputTokenMint.equals(NATIVE_MINT) && calls[1].inputTokenMint.equals(tokenAMint))
  assert.deepEqual([calls[0].slippage, calls[0].currentPoint.toString(), calls[0].amountIn.toString()], [100, '1800000000', '1000'], 'timestamp pools quote at unix time')
})

test('the agent never sends a trade without the quoted minimum, and only while launches are on', () => {
  const source = readFileSync(new URL('../src/bundle-jobs.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /minimumOut: 1\b/)
  assert.equal(source.match(/buy: decision\.buy, amountIn: decision\.amountIn, minimumOut, programId: program/g)?.length, 2, 'curve and pool swaps')
  assert.match(source, /if \(!agentsLive \|\| !operator \|\| !launchesOn\) return \{ agent: 'dry run', \.\.\.planned \}/)
  assert.match(source, /catch \(error\) \{ return \{ agent: 'hold', reason: `No quote: /)
})
