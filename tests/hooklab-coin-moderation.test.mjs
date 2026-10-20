// Owner moderation never traps holders: a delisted coin's BUY is refused on the site, while SELL (bridged and native) and
// the creator's fee CLAIM go on exactly as before. The owner's endpoint needs the owner token and open launches. Injected
// runtimes and stores; no RPC, no database.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createInclusiveTradeHandler } from '../app/lib/hooklab-inclusive-trade.mjs'
import { createNativeClaimHandler } from '../app/lib/hooklab-native-claim.mjs'
import { createCoinModerationHandler } from '../app/lib/hooklab-coin-moderation.mjs'
import { DELISTING_REASONS, DELISTED_BUY_REFUSAL, isDelistingReason, moderationState } from '../src/hooklab-coin-moderation.mjs'
import { createHash } from 'node:crypto'

const id = '11111111-1111-4111-8111-111111111111', token = Buffer.alloc(32, 9).toString('base64url'), owner = '11111111111111111111111111111111'
const delistedMint = '2T2kXXWkSYV88iKTN1v6dwrXuhqfu9FFpzPozChtfpYn', listedMint = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
const base = { configuration: () => ({ origin: 'https://repo.ing' }), database: () => ({ end: async () => {} }), quota: async () => true, principalStore: () => ({ resolve: async () => ({ wallet: owner }) }) }
const request = (path, body, headers = {}) => new Request(`https://repo.ing/api/hook-lab/${path}`, { method: 'POST',
  headers: { origin: 'https://repo.ing', 'content-type': 'application/json', cookie: `__Host-hook-wallet-session=${token}`, ...headers }, body: JSON.stringify(body) })
const json = async response => ({ status: response.status, body: await response.json() })
const moderation = async (_pool, mint) => mint === delistedMint ? moderationState([{ id: 1, action: 'delist', reason: Object.keys(DELISTING_REASONS)[0], decided_at: '2026-10-19T12:00:00Z' }]) : { delisted: false }

test('the delisting reasons are exactly the owner\'s five, each a plain sentence', () => {
  assert.deepEqual(Object.keys(DELISTING_REASONS), ['impersonation', 'misleading', 'harmful-content', 'malicious-links', 'legal'])
  for (const text of Object.values(DELISTING_REASONS)) { assert.doesNotMatch(text, /PLACEHOLDER|pending/i); assert.match(text, /^[A-Z].*\.$/) }
  assert.equal(isDelistingReason('impersonation'), true); assert.equal(isDelistingReason('placeholder-content-rules'), false); assert.equal(isDelistingReason('made-up'), false)
  assert.deepEqual(moderationState([{ id: 1, action: 'delist', reason: 'impersonation', decided_at: '2026-10-19T12:00:00Z' }, { id: 2, action: 'relist', reason: null, decided_at: '2026-10-19T13:00:00Z' }]), { delisted: false })
  assert.match(moderationState([{ id: 7, action: 'delist', reason: 'impersonation', decided_at: '2026-10-19T12:00:00Z' }]).notice, /You can still sell it, and its creator can still claim fees/)
})

test('a delisted coin: BUY is refused, SELL (bridged and native) goes on; other coins are untouched', async () => {
  const env = { HOOK_INCLUSIVE_TRADING_ENABLED: 'true', HOOK_WALLET_IDENTITY_ENABLED: 'true', HOOK_TRADING_PUBLIC: 'true', HOOK_NATIVE_TRADING_ENABLED: 'true', HOOK_OPEN_LAUNCHES: 'true' }
  const seen = [], lifecycle = { createReview: async (_t, _i, value) => { seen.push(value.stage); return { id, owner, stage: value.stage, status: 'reviewed', review: { messageBase64: 'NEVER', messageSha256: 'a'.repeat(64) } } } }
  const handle = createInclusiveTradeHandler({ ...base, env, moderation, runtime: () => ({ origin: 'https://repo.ing', lifecycle, walletFunding: true, walletWithdraw: true, nativeTrading: true }) })
  const intent = (mint, side) => ({ mint, selectedConfig: owner, capBps: 200, creatorFeeBps: 100, side, amountIn: '100000', minAmountOut: '1', maxInput: '100000', maxPriceImpactBps: 1000 })
  for (const action of ['quote', 'native-quote']) {
    const extra = action === 'native-quote' ? { graduate: false } : {}
    const buy = await json(await handle(request('inclusive-trade', { action, signingId: id, request: { ...intent(delistedMint, 'buy'), ...extra } })))
    assert.deepEqual(buy.body.blockers, [{ code: 'COIN_DELISTED', message: DELISTED_BUY_REFUSAL }])
    assert.equal((await json(await handle(request('inclusive-trade', { action, signingId: id, request: { ...intent(delistedMint, 'sell'), ...extra } })))).status, 200)
    assert.equal((await json(await handle(request('inclusive-trade', { action, signingId: id, request: { ...intent(listedMint, 'buy'), ...extra } })))).status, 200)
  }
  assert.deepEqual(seen, ['inclusive-sell', 'inclusive-buy', 'native-sell', 'native-buy'], 'nothing is reviewed for the refused buys')
})

test('the creator still claims a delisted coin\'s fees: the claim path never reads moderation', async () => {
  const env = { HOOK_NATIVE_LAUNCHES_ENABLED: 'true', HOOK_WALLET_IDENTITY_ENABLED: 'true', HOOK_OPEN_LAUNCHES: 'true' }, seen = []
  const lifecycle = { createReview: async (_t, _i, value) => { seen.push(value); return { id, owner, stage: value.stage, status: 'reviewed', request: value.intent, review: { operation: 'hooklab-native-claim', messageBase64: 'NEVER', messageSha256: 'a'.repeat(64) } } } }
  const delisted = { id: 'r', moderation: { delisted: true, reason: 'impersonation' } }
  const handle = createNativeClaimHandler({ ...base, env, runtime: () => ({ origin: 'https://repo.ing', lifecycle, coinProfile: async () => delisted,
    status: async m => ({ mint: m, native: true, creator: owner, claimableLamports: '5625000' }) }) })
  assert.equal((await json(await handle(request('native-claim', { action: 'status', mint: delistedMint })))).body.claim.claimableLamports, '5625000')
  const claimed = await json(await handle(request('native-claim', { action: 'claim', signingId: id, mint: delistedMint })))
  assert.equal(claimed.status, 200); assert.equal(seen[0].intent.mint, delistedMint)
})

test('the owner\'s moderation endpoint: open launches only, the owner token, a known reason, and the store decides', async () => {
  const tokenValue = 'o'.repeat(40), env = { HOOK_OPEN_LAUNCHES: 'true', HOOK_OWNER_APPROVAL_TOKEN_SHA256: createHash('sha256').update(tokenValue).digest('hex') }
  const calls = [], store = () => ({ moderate: async args => { calls.push(args); return { delisted: args.action === 'delist' } } })
  const handle = createCoinModerationHandler({ env, configuration: () => ({}), database: () => ({ end: async () => {} }), store })
  const post = (body, auth = `Bearer ${tokenValue}`) => handle(new Request('https://repo.ing/api/hook-lab/coin-moderation', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  assert.equal((await createCoinModerationHandler({ env: {} })(new Request('https://repo.ing/api/hook-lab/coin-moderation', { method: 'POST' }))).status, 503)
  assert.equal((await post({ action: 'delist', mint: delistedMint, reason: 'impersonation' }, 'Bearer wrong-token-wrong-token-wrong-token')).status, 401)
  const done = await json(await post({ action: 'delist', mint: delistedMint, reason: 'impersonation' }))
  assert.equal(done.status, 200); assert.deepEqual(calls, [{ mint: delistedMint, action: 'delist', reason: 'impersonation', actor: 'owner' }])
  assert.equal((await post({ action: 'relist', mint: delistedMint })).status, 200); assert.equal(calls[1].reason, null)
})
