import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'
import { BLOCKED_WALLET_MESSAGE, BlockedWalletError, WALLET_BLOCKED, assertWalletAllowed, blockedWallets, isBlockedWallet, walletAddress } from '../src/blocked-wallets.mjs'
import { prepareCheckedTrade } from '../src/trade-prepare.mjs'
import { prepareActionTrade } from '../app/lib/action-trades.mjs'
import { handleBuyPost } from '../app/lib/solana-actions.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { launchFailure } from '../src/launch-failure.mjs'

// Blocked wallets (src/blocked-wallets.mjs, docs/PRODUCTION.md): BLOCKED_WALLETS refuses a wallet's trades (site and Blinks),
// launch reviews and Group launch raises before anything is built. The Group launch cases are in tests/bundle-raise.test.mjs.
// Test wallets only: the real list lives in a private Railway variable, never in this public repository.

const blocked = Keypair.generate().publicKey, other = Keypair.generate().publicKey
const MINT = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'
const market = { repoId: '1388219884', mint: MINT, symbol: 'REPOING', fullName: 'New1Direction/repo.ing', description: 'Open source markets.' }
const quiet = t => t.mock.method(console, 'warn', () => {})
function withList(t, value) {
  const before = process.env.BLOCKED_WALLETS
  process.env.BLOCKED_WALLETS = value
  t.after(() => { if (before === undefined) delete process.env.BLOCKED_WALLETS; else process.env.BLOCKED_WALLETS = before })
}
// An engine that fails the test if a blocked wallet ever reaches it.
const untouchedEngine = () => ({ prepareBuy: async () => { throw Error('trader must not run') }, prepareSell: async () => { throw Error('trader must not run') } })

test('the list: canonical addresses separated by commas, spaces or new lines; anything else is left out and counted', t => {
  quiet(t)
  const env = { BLOCKED_WALLETS: ` ${blocked.toBase58()},\n${other.toBase58()} , not-a-wallet,0${blocked.toBase58().slice(1)}` }
  const list = blockedWallets(env)
  assert.deepEqual([...list.wallets].sort(), [blocked.toBase58(), other.toBase58()].sort())
  assert.equal(list.invalid, 2)
  assert.equal(isBlockedWallet(blocked.toBase58(), env), true)
  assert.equal(isBlockedWallet(blocked, env), true, 'a PublicKey matches too')
  assert.equal(isBlockedWallet(Array.from(blocked.toBytes()), env), true, 'and its 32 bytes')
  assert.equal(walletAddress(Array.from(blocked.toBytes())), blocked.toBase58())
  assert.equal(walletAddress('nope'), null)
  assert.equal(isBlockedWallet(Keypair.generate().publicKey.toBase58(), env), false)
  assert.equal(isBlockedWallet(null, env), false)
  // Unset or empty: nobody is blocked.
  assert.equal(isBlockedWallet(blocked.toBase58(), {}), false)
  assert.equal(isBlockedWallet(blocked.toBase58(), { BLOCKED_WALLETS: '' }), false)
  assert.doesNotThrow(() => assertWalletAllowed(other.toBase58(), { BLOCKED_WALLETS: blocked.toBase58() }))
  assert.throws(() => assertWalletAllowed(blocked.toBase58(), { BLOCKED_WALLETS: blocked.toBase58() }),
    error => error instanceof BlockedWalletError && error.code === WALLET_BLOCKED && error.message === BLOCKED_WALLET_MESSAGE)
})

test('trades: the one prepare path refuses a blocked wallet, buy or sell, before the trader runs', async t => {
  withList(t, blocked.toBase58())
  for (const direction of ['buy', 'sell']) {
    await assert.rejects(prepareCheckedTrade({ engine: untouchedEngine(), connection: {}, direction, githubRepoId: market.repoId,
      wallet: blocked.toBase58(), amountBaseUnits: '1000' }), { code: WALLET_BLOCKED, message: BLOCKED_WALLET_MESSAGE })
  }
  // The same wallet sent as 32 bytes (JSON accepts an array; the trader's PublicKey would too) is refused the same way.
  await assert.rejects(prepareCheckedTrade({ engine: untouchedEngine(), connection: {}, direction: 'buy', githubRepoId: market.repoId,
    wallet: Array.from(blocked.toBytes()), amountBaseUnits: '1000' }), { code: WALLET_BLOCKED })
  await assert.rejects(prepareCheckedTrade({ engine: untouchedEngine(), connection: {}, direction: 'buy', githubRepoId: market.repoId,
    wallet: 'nope', amountBaseUnits: '1000' }), /^Error: Invalid trade wallet$/)
  // Another wallet goes on to the trader as before, always as its canonical address.
  const seen = []
  const engine = { prepareBuy: async request => { seen.push(request.wallet); throw Error('stop after the trader') } }
  for (const wallet of [other.toBase58(), Array.from(other.toBytes())]) {
    await assert.rejects(prepareCheckedTrade({ engine, connection: {}, direction: 'buy', githubRepoId: market.repoId, wallet, amountBaseUnits: '1000' }),
      /stop after the trader/)
  }
  assert.deepEqual(seen, [other.toBase58(), other.toBase58()])
})

test('trades: the site trade API shows the refusal; it is not replaced by the generic error', () => {
  assert.match(readFileSync('app/api/trade/route.js', 'utf8'), /const SAFE = \/\^\(This wallet cannot trade\|/)
  assert.ok(BLOCKED_WALLET_MESSAGE.startsWith('This wallet cannot trade'))
})

test('trades: a Blink buy from a blocked wallet gets the refusal, with or without a referral', async t => {
  withList(t, blocked.toBase58())
  const prepareBuy = trade => prepareActionTrade('buy', trade, { router: async () => untouchedEngine(), connection: {} })
  const ref = Keypair.generate().publicKey.toBase58()
  const response = await handleBuyPost(new Request(`https://repo.ing/api/actions/buy/${MINT}?amount=0.5&ref=${ref}`,
    { method: 'POST', body: JSON.stringify({ account: blocked.toBase58() }) }), MINT, { loadMarket: async () => market, prepareBuy })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).message, BLOCKED_WALLET_MESSAGE)
})

test('launches: a blocked launcher wallet is refused before the repository is read or reserved, and cannot retry', async t => {
  withList(t, blocked.toBase58())
  const creatorWallet = Keypair.generate().publicKey.toBase58()
  const coordinator = createLaunchCoordinator({ pool: {}, launcher: { creatorWallet, prepare: async () => { throw Error('launcher must not run') } },
    fetchImpl: async () => { throw Error('GitHub must not be read') } })
  const request = { repositoryUrl: 'https://github.com/octo/widget', tokenName: 'Widget', tokenSymbol: 'WDGT', tokenImage: null,
    launcherWallet: blocked.toBase58(), onPrepared: async () => { throw Error('nothing may be stored') } }
  const error = await coordinator.prepareLaunch(request).then(() => null, error => error)
  assert.equal(error?.code, WALLET_BLOCKED)
  assert.deepEqual(launchFailure(error, 'prepare'), { error: BLOCKED_WALLET_MESSAGE, canRetry: false, code: WALLET_BLOCKED })
  // Another wallet goes on to read the repository, as before.
  await assert.rejects(coordinator.prepareLaunch({ ...request, launcherWallet: other.toBase58() }), /GitHub must not be read|Repository/)
})

