import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { ACTION_HEADERS, ACTIONS_JSON, MAX_BUY_LAMPORTS, actionOptions, handleBuyGet, handleBuyPost, loadActionMarket,
  parseAccount, parseBuyAmount } from '../app/lib/solana-actions.mjs'
import { dialToUrl, marketUrl } from '../app/lib/blink-links.mjs'
import { GET as actionsJsonGet, OPTIONS as actionsJsonOptions } from '../app/actions.json/route.js'

const MINT = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'
const market = { repoId: '1388219884', mint: MINT, symbol: 'REPOING', fullName: 'New1Direction/repo.ing', description: 'Open source markets.' }
const wallet = Keypair.generate().publicKey
const loadMarket = async mint => mint === MINT ? market : null
const post = (body, amount = '0.5', mint = MINT) => handleBuyPost(new Request(`https://repo.ing/api/actions/buy/${mint}?amount=${amount}`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }), mint, { loadMarket, prepareBuy: fakePrepare() })
function fakePrepare(calls = []) {
  return async request => {
    calls.push(request)
    const payer = new PublicKey(request.wallet)
    const tx = new Transaction({ feePayer: payer, recentBlockhash: '11111111111111111111111111111111' })
      .add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }))
    return { transaction: tx, direction: 'buy', mint: MINT, amountIn: BigInt(request.amountLamports), minimumAmountOut: 1234567n }
  }
}
const assertActionHeaders = response => {
  for (const [key, value] of Object.entries(ACTION_HEADERS)) assert.equal(response.headers.get(key), value, key)
  assert.equal(response.headers.get('X-Action-Version'), '2.4')
  assert.equal(response.headers.get('X-Blockchain-Ids'), 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
}

test('parseBuyAmount converts decimal SOL to exact lamports and enforces the cap', () => {
  assert.equal(parseBuyAmount('0.1'), 100_000_000n)
  assert.equal(parseBuyAmount('1'), 1_000_000_000n)
  assert.equal(parseBuyAmount('.5'), 500_000_000n)
  assert.equal(parseBuyAmount('0.000000001'), 1n)
  assert.equal(parseBuyAmount('50'), MAX_BUY_LAMPORTS)
  for (const bad of [null, '', '0', '0.0', '-1', '1e3', '0x10', '1.0000000001', '50.000000001', '1,5', 'NaN', 'Infinity', ' ', '1 SOL'])
    assert.throws(() => parseBuyAmount(bad), { name: 'Error' }, String(bad))
  assert.throws(() => parseBuyAmount('51'), /at most 50 SOL/)
})

test('parseAccount accepts wallets and rejects malformed or off-curve addresses', () => {
  assert.equal(parseAccount(wallet.toBase58()).toBase58(), wallet.toBase58())
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('x')], SystemProgram.programId)
  for (const bad of [undefined, 42, '', 'not-a-key', // Two extra characters: a 43-char address plus one can still decode to a valid 32-byte key.
    `${wallet.toBase58()}xx`, pda.toBase58()])
    assert.throws(() => parseAccount(bad), /Invalid account/)
})

test('actions.json maps market pages to the buy action with CORS and action headers', async () => {
  assert.deepEqual(ACTIONS_JSON.rules[0], { pathPattern: '/token/*', apiPath: '/api/actions/buy/*' })
  const response = actionsJsonGet()
  assertActionHeaders(response)
  assert.deepEqual(await response.json(), ACTIONS_JSON)
  const options = actionsJsonOptions()
  assertActionHeaders(options)
  assert.equal(options.status, 204)
})

test('OPTIONS preflight carries every Actions header', () => {
  const response = actionOptions()
  assertActionHeaders(response)
  assert.match(response.headers.get('Access-Control-Allow-Methods'), /POST/)
})

test('GET returns the buy action with presets and a custom amount input', async () => {
  const response = await handleBuyGet(MINT, { loadMarket })
  assert.equal(response.status, 200)
  assertActionHeaders(response)
  const action = await response.json()
  assert.equal(action.type, 'action')
  assert.equal(action.icon, `https://repo.ing/api/token-image/${MINT}`)
  assert.equal(action.title, '$REPOING · New1Direction/repo.ing')
  assert.equal(action.label, 'Buy')
  assert.ok(action.description.startsWith('Open source markets.'))
  assert.equal(action.disabled, undefined)
  const links = action.links.actions
  assert.deepEqual(links.slice(0, 3).map(link => [link.type, link.label, link.href]), [
    ['transaction', 'Buy 0.1 SOL', `/api/actions/buy/${MINT}?amount=0.1`],
    ['transaction', 'Buy 0.5 SOL', `/api/actions/buy/${MINT}?amount=0.5`],
    ['transaction', 'Buy 1 SOL', `/api/actions/buy/${MINT}?amount=1`]])
  assert.equal(links[3].href, `/api/actions/buy/${MINT}?amount={amount}`)
  assert.deepEqual(links[3].parameters.map(p => [p.name, p.type, p.required, p.max]), [['amount', 'number', true, 50]])
})

test('GET marks the action disabled when trading is not configured', async () => {
  const action = await (await handleBuyGet(MINT, { loadMarket, tradingEnabled: () => false })).json()
  assert.equal(action.disabled, true)
  assert.match(action.error.message, /unavailable/)
})

test('GET returns spec action errors for malformed, unknown and unavailable markets', async () => {
  const bad = await handleBuyGet('not-a-mint', { loadMarket })
  assert.equal(bad.status, 400)
  assertActionHeaders(bad)
  assert.deepEqual(await bad.json(), { message: 'Invalid token mint' })
  const unknown = await handleBuyGet(Keypair.generate().publicKey.toBase58(), { loadMarket })
  assert.equal(unknown.status, 404)
  assert.match((await unknown.json()).message, /No indexed repo.ing market/)
  const down = await handleBuyGet(MINT, { loadMarket: async () => { throw Error('connect ECONNREFUSED db.internal:5432') } })
  assert.equal(down.status, 503)
  assert.doesNotMatch((await down.json()).message, /internal/)
})

test('POST builds the unsigned transaction through the injected canonical prepareBuy', async () => {
  const calls = []
  const response = await handleBuyPost(new Request(`https://repo.ing/api/actions/buy/${MINT}?amount=0.5`,
    { method: 'POST', body: JSON.stringify({ account: wallet.toBase58() }) }), MINT, { loadMarket, prepareBuy: fakePrepare(calls) })
  assert.equal(response.status, 200)
  assertActionHeaders(response)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const body = await response.json()
  assert.deepEqual(calls, [{ githubRepoId: '1388219884', wallet: wallet.toBase58(), amountLamports: '500000000' }])
  assert.equal(body.type, 'transaction')
  const tx = Transaction.from(Buffer.from(body.transaction, 'base64'))
  assert.equal(tx.feePayer.toBase58(), wallet.toBase58())
  assert.equal(tx.signatures[0].signature, null)
  assert.match(body.message, /\$REPOING with 0\.5 SOL.*at least 1\.234567 \$REPOING/)
  assert.equal(body.links.next.type, 'inline')
  assert.equal(body.links.next.action.type, 'completed')
})

test('POST rejects bad amounts, accounts and bodies before touching the trader', async () => {
  const cases = [[{ account: wallet.toBase58() }, '0', 400, /greater than 0/], [{ account: wallet.toBase58() }, '100', 400, /at most 50/],
    [{ account: wallet.toBase58() }, 'abc', 400, /SOL amount/], [{ account: 'nope' }, '0.1', 400, /Invalid account/],
    [{}, '0.1', 400, /Invalid account/], ['{not json', '0.1', 400, /JSON/], [JSON.stringify({ account: 'x'.repeat(5000) }), '0.1', 413, /too large/]]
  for (const [body, amount, status, message] of cases) {
    const response = await handleBuyPost(new Request(`https://repo.ing/api/actions/buy/${MINT}?amount=${amount}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
      MINT, { loadMarket, prepareBuy: async () => { throw Error('trader must not run') } })
    assert.equal(response.status, status, `${amount} ${String(body).slice(0, 20)}`)
    assertActionHeaders(response)
    assert.match((await response.json()).message, message)
  }
  const unknown = await post({ account: wallet.toBase58() }, '0.1', Keypair.generate().publicKey.toBase58())
  assert.equal(unknown.status, 404)
})

test('POST surfaces app-authored trader errors and hides infrastructure errors', async () => {
  const run = error => handleBuyPost(new Request(`https://repo.ing/api/actions/buy/${MINT}?amount=1`, { method: 'POST', body: JSON.stringify({ account: wallet.toBase58() }) }),
    MINT, { loadMarket, prepareBuy: async () => { throw error } })
  const shortfall = await run(Error('You need approximately 0.200000 more SOL, including fees and refundable account deposits.'))
  assert.equal(shortfall.status, 400)
  assert.match((await shortfall.json()).message, /You need approximately/)
  const rpc = await run(Error('fetch failed https://mainnet.helius-rpc.com/?api-key=secret'))
  assert.equal(rpc.status, 500)
  assert.doesNotMatch((await rpc.json()).message, /secret|helius/)
})

test('POST refuses a prepared trade that does not match the request', async () => {
  const response = await handleBuyPost(new Request(`https://repo.ing/api/actions/buy/${MINT}?amount=1`, { method: 'POST', body: JSON.stringify({ account: wallet.toBase58() }) }),
    MINT, { loadMarket, prepareBuy: async request => ({ ...(await fakePrepare()(request)), amountIn: 1n }) })
  assert.equal(response.status, 500)
})

test('loadActionMarket reads only canonical finalized markets', async () => {
  let seen
  const row = await loadActionMarket({ query: async (sql, values) => { seen = { sql, values }; return { rows: [market] } } }, MINT)
  assert.equal(row, market)
  assert.deepEqual(seen.values, [MINT])
  assert.match(seen.sql, /status = 'confirmed' and m\.indexed_at is not null and m\.launch_finality = 'finalized'/)
  assert.equal(await loadActionMarket({ query: async () => ({ rows: [] }) }, MINT), null)
})

test('share helpers produce the market URL and an encoded dial.to Blink link', () => {
  assert.equal(marketUrl(MINT), `https://repo.ing/token/${MINT}`)
  assert.equal(dialToUrl(MINT), `https://dial.to/?action=solana-action%3Ahttps%3A%2F%2Frepo.ing%2Fapi%2Factions%2Fbuy%2F${MINT}`)
})
