import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { ACCOUNT_SIZE, AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { ACTION_HEADERS, handleBuyGet, handleBuyPost, handleSellGet, handleSellPost, parseActionReferrer, parseSellPercent,
  SELL_PERCENTS } from '../app/lib/solana-actions.mjs'
import { prepareActionTrade, walletTokenBalance } from '../app/lib/action-trades.mjs'

const MINT = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'
const market = { repoId: '1388219884', mint: MINT, symbol: 'REPOING', fullName: 'New1Direction/repo.ing', description: 'Open source markets.' }
const wallet = Keypair.generate().publicKey
const referrer = Keypair.generate().publicKey.toBase58()
const [pda] = PublicKey.findProgramAddressSync([Buffer.from('ref')], SystemProgram.programId)
const loadMarket = async mint => mint === MINT ? market : null

function fakeTrader(direction, calls) {
  return async request => {
    calls.push(request)
    const payer = new PublicKey(request.wallet)
    const tx = new Transaction({ feePayer: payer, recentBlockhash: '11111111111111111111111111111111' })
      .add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }))
    return { transaction: tx, direction, mint: MINT, minimumAmountOut: 123_456_789n,
      amountIn: BigInt(direction === 'buy' ? request.amountLamports : request.amountBaseUnits) }
  }
}

async function sell({ percent = '50', ref = null, body = { account: wallet.toBase58() }, balance = 1_000_000_001n, prepareSell = null } = {}) {
  const calls = [], reads = []
  const response = await handleSellPost(new Request(`https://repo.ing/api/actions/sell/${MINT}?percent=${percent}${ref ? `&ref=${ref}` : ''}`,
    { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), MINT, { loadMarket,
    tokenBalance: async (owner, mint) => { reads.push([owner.toBase58(), mint]); if (balance instanceof Error) throw balance; return balance },
    prepareSell: prepareSell ?? fakeTrader('sell', calls) })
  return { response, json: await response.json(), calls, reads }
}

test('sell percentages are exactly 25, 50 or 100', () => {
  assert.deepEqual(SELL_PERCENTS, [25, 50, 100])
  for (const ok of ['25', '50', '100']) assert.equal(parseSellPercent(ok), Number(ok))
  for (const bad of [null, '', '0', '10', '75', '100.0', '25%', ' 50', '1e2']) assert.throws(() => parseSellPercent(bad), /25%, 50% or 100%/, String(bad))
})

test('POST sells a share of the balance read server-side for the signing account, through the canonical trader', async () => {
  const { response, json, calls, reads } = await sell()
  assert.equal(response.status, 200)
  for (const [key, value] of Object.entries(ACTION_HEADERS)) assert.equal(response.headers.get(key), value, key)
  assert.deepEqual(reads, [[wallet.toBase58(), MINT]])
  assert.deepEqual(calls, [{ githubRepoId: '1388219884', wallet: wallet.toBase58(), amountBaseUnits: '500000000' }], 'floor of 50%, no slippage override')
  assert.equal(json.type, 'transaction')
  assert.equal(Transaction.from(Buffer.from(json.transaction, 'base64')).feePayer.toBase58(), wallet.toBase58())
  assert.equal(json.message, 'Selling 500 $REPOING (50% of your balance) · at least 0.123456 SOL (1% max slippage).')
  assert.equal(json.links.next.action.type, 'completed')
  assert.equal(json.links.next.action.title, '$REPOING sold')
  const all = await sell({ percent: '100', balance: 7_654_321n })
  assert.equal(all.calls[0].amountBaseUnits, '7654321', 'sell all spends the whole balance')
})

test('an empty or dust balance fails with a clear message before the trader runs', async () => {
  const empty = await sell({ balance: 0n })
  assert.equal(empty.response.status, 400)
  assert.equal(empty.json.message, 'This wallet holds no $REPOING to sell.')
  assert.deepEqual(empty.calls, [])
  const dust = await sell({ percent: '25', balance: 3n })
  assert.equal(dust.response.status, 400)
  assert.match(dust.json.message, /too small to sell 25%\. Try selling all of it/)
  assert.deepEqual(dust.calls, [])
})

test('sell refuses bad input before reading balances and hides balance-read infrastructure errors', async () => {
  for (const [options, status, message] of [[{ percent: '10' }, 400, /25%, 50% or 100%/], [{ body: { account: 'nope' } }, 400, /Invalid account/],
    [{ body: '{oops' }, 400, /JSON/], [{ body: { account: pda.toBase58() } }, 400, /Invalid account/]]) {
    const { response, json, reads, calls } = await sell(options)
    assert.equal(response.status, status)
    assert.match(json.message, message)
    assert.deepEqual([reads, calls], [[], []])
  }
  const down = await sell({ balance: Error('fetch failed https://mainnet.helius-rpc.com/?api-key=secret') })
  assert.equal(down.response.status, 503)
  assert.doesNotMatch(down.json.message, /helius|secret/)
  const mismatch = await sell({ prepareSell: async request => ({ ...(await fakeTrader('sell', [])(request)), amountIn: 1n }) })
  assert.equal(mismatch.response.status, 500)
  const simulation = await sell({ prepareSell: async () => { throw Error('Trade simulation did not pass. Refresh the quote and check your wallet balance before trying again.') } })
  assert.equal(simulation.response.status, 400)
  assert.match(simulation.json.message, /Trade simulation did not pass/)
})

test('?ref passes a valid referrer wallet to buys and sells; anything else is dropped, never an error', async () => {
  assert.equal(parseActionReferrer(referrer), referrer)
  // A trailing "0" is never base58, so the last case is always malformed (a trailing letter made a valid wallet ~0.6% of runs).
  for (const bad of [null, '', 'nonsense', pda.toBase58(), `${referrer}0`]) assert.equal(parseActionReferrer(bad), null, String(bad))
  assert.equal((await sell({ ref: referrer })).calls[0].referrer, referrer)
  assert.equal('referrer' in (await sell({ ref: pda.toBase58() })).calls[0], false)
  const buys = []
  const buy = ref => handleBuyPost(new Request(`https://repo.ing/api/actions/buy/${MINT}?amount=0.1${ref ? `&ref=${ref}` : ''}`,
    { method: 'POST', body: JSON.stringify({ account: wallet.toBase58() }) }), MINT, { loadMarket, prepareBuy: fakeTrader('buy', buys) })
  assert.equal((await buy(referrer)).status, 200)
  assert.equal((await buy('junk')).status, 200)
  assert.deepEqual(buys, [{ githubRepoId: '1388219884', wallet: wallet.toBase58(), amountLamports: '100000000', referrer },
    { githubRepoId: '1388219884', wallet: wallet.toBase58(), amountLamports: '100000000' }])
})

test('the market Blink offers sells to holders, and a shared ref rides on every linked action', async () => {
  const plain = await (await handleBuyGet(MINT, { loadMarket })).json()
  const sells = plain.links.actions.slice(4)
  assert.deepEqual(sells.map(link => [link.type, link.label, link.href]), [
    ['transaction', 'Sell 25%', `/api/actions/sell/${MINT}?percent=25`],
    ['transaction', 'Sell 50%', `/api/actions/sell/${MINT}?percent=50`],
    ['transaction', 'Sell all', `/api/actions/sell/${MINT}?percent=100`]])
  assert.match(plain.description, /Trades use the canonical repo\.ing pool with 1% max slippage/)
  const referred = await (await handleBuyGet(MINT, { loadMarket, ref: referrer })).json()
  assert.equal(referred.links.actions.length, 7)
  for (const link of referred.links.actions) assert.ok(link.href.endsWith(`&ref=${referrer}`), link.href)
  assert.equal(referred.links.actions[3].href, `/api/actions/buy/${MINT}?amount={amount}&ref=${referrer}`)
  const ignored = await (await handleBuyGet(MINT, { loadMarket, ref: 'nonsense' })).json()
  assert.deepEqual(ignored.links, plain.links)
})

test('GET sell is a standalone sell Blink with the same buttons, disabled when trading is off', async () => {
  const response = await handleSellGet(MINT, { loadMarket, ref: referrer })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=60')
  const action = await response.json()
  assert.equal(action.label, 'Sell')
  assert.equal(action.title, 'Sell $REPOING · New1Direction/repo.ing')
  assert.deepEqual(action.links.actions.map(link => link.href), [25, 50, 100].map(p => `/api/actions/sell/${MINT}?percent=${p}&ref=${referrer}`))
  assert.equal((await (await handleSellGet(MINT, { loadMarket, tradingEnabled: () => false })).json()).disabled, true)
  assert.equal((await handleSellGet('not-a-mint', { loadMarket })).status, 400)
  assert.equal((await handleSellGet(Keypair.generate().publicKey.toBase58(), { loadMarket })).status, 404)
})

function tokenAccount({ mint = new PublicKey(MINT), owner = wallet, amount = 0n } = {}) {
  const data = Buffer.alloc(ACCOUNT_SIZE)
  AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n,
    delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data)
  return { owner: TOKEN_PROGRAM_ID, data, lamports: 2_039_280, executable: false }
}

test('the sell balance is the signing wallet\'s own associated token account for this mint', async () => {
  const reads = []
  const connection = account => ({ getAccountInfo: async (address, commitment) => { reads.push([address.toBase58(), commitment]); return account } })
  assert.equal(await walletTokenBalance(wallet, MINT, connection(tokenAccount({ amount: 42_000_000n }))), 42_000_000n)
  assert.deepEqual(reads[0], [getAssociatedTokenAddressSync(new PublicKey(MINT), wallet).toBase58(), 'confirmed'])
  assert.equal(await walletTokenBalance(wallet, MINT, connection(null)), 0n, 'no token account: nothing to sell')
  assert.equal(await walletTokenBalance(wallet, MINT, connection({ ...tokenAccount({ amount: 5n }), owner: SystemProgram.programId })), 0n)
  assert.equal(await walletTokenBalance(wallet, MINT, connection(tokenAccount({ amount: 5n, owner: Keypair.generate().publicKey }))), 0n)
  assert.equal(await walletTokenBalance(wallet, MINT, connection(tokenAccount({ amount: 5n, mint: Keypair.generate().publicKey }))), 0n)
})

test('a Blink trade whose referral cannot be prepared retries once without it, at the default slippage', async () => {
  const tx = new Transaction({ feePayer: wallet, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    .add(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wallet, lamports: 1 }))
  const requests = []
  const engine = { prepareSell: async request => {
    requests.push(request)
    if (request.referrer) throw Error('referral account unreadable')
    return { transaction: tx, direction: 'sell', amountIn: BigInt(request.amountBaseUnits) }
  } }
  const connection = { getBalance: async () => 1_000_000_000, getFeeForMessage: async () => ({ value: 5000 }),
    simulateTransaction: async () => ({ value: { err: null } }) }
  const deps = { router: async () => engine, connection }
  const prepared = await prepareActionTrade('sell', { githubRepoId: '1', wallet: wallet.toBase58(), amountBaseUnits: '500', referrer }, deps)
  assert.equal(prepared.amountIn, 500n)
  assert.deepEqual(requests.map(request => request.referrer), [referrer, null])
  assert.deepEqual(requests.map(request => request.slippageBps), [undefined, undefined], 'Blinks keep the trader default (1%)')
  requests.length = 0
  engine.prepareSell = async request => { requests.push(request); throw Error('Trade simulation did not pass.') }
  await assert.rejects(prepareActionTrade('sell', { githubRepoId: '1', wallet: wallet.toBase58(), amountBaseUnits: '500' }, deps), /simulation/)
  assert.equal(requests.length, 1, 'without a referral the trader\'s own failure is final')
})
