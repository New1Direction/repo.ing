// Creator fee claims over HTTP: off unless HOOK_NATIVE_LAUNCHES_ENABLED=true, the trade API's origin, session and
// injection rules, one stage (native-claim) bound to the session wallet, and plain refusals. Injected runtime; no RPC.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeClaimHandler } from '../app/lib/hooklab-native-claim.mjs'
import { createNativeClaimRuntime, nativeClaimRuntime } from '../app/lib/hooklab-native-claim-runtime.mjs'

const id = '11111111-1111-4111-8111-111111111111', token = Buffer.alloc(32, 9).toString('base64url'), owner = '11111111111111111111111111111111'
const mint = '2T2kXXWkSYV88iKTN1v6dwrXuhqfu9FFpzPozChtfpYn'
const options = { env: { HOOK_NATIVE_LAUNCHES_ENABLED: 'true', HOOK_WALLET_IDENTITY_ENABLED: 'true' }, configuration: () => ({ origin: 'https://repo.ing' }), database: () => ({ end: async () => {} }),
  quota: async () => true, principalStore: () => ({ resolve: async () => ({ wallet: owner }) }) }
const request = (body, headers = {}, url = 'https://repo.ing/api/hook-lab/native-claim') => new Request(url, { method: 'POST',
  headers: { origin: 'https://repo.ing', 'content-type': 'application/json', cookie: `__Host-hook-wallet-session=${token}`, ...headers }, body: JSON.stringify(body) })
const json = async response => response.json()

test('claims stay off without HOOK_NATIVE_LAUNCHES_ENABLED, and the runtime needs explicit approval', async () => {
  assert.equal(nativeClaimRuntime(), null); assert.throws(() => createNativeClaimRuntime({}, {}), /approval/)
  for (const env of [{}, { HOOK_WALLET_IDENTITY_ENABLED: 'true' }, { HOOK_NATIVE_LAUNCHES_ENABLED: 'true' }, { HOOK_NATIVE_LAUNCHES_ENABLED: '1', HOOK_WALLET_IDENTITY_ENABLED: 'true' }])
    assert.equal((await json(await createNativeClaimHandler({ ...options, env })(request({ action: 'status', mint })))).blockers[0].code, 'NATIVE_CLAIMS_DISABLED')
  assert.equal((await json(await createNativeClaimHandler({ ...options, runtime: () => null })(request({ action: 'status', mint })))).blockers[0].code, 'NATIVE_CLAIM_RUNTIME_UNCONFIGURED')
})

test('status is a public read: no session needed, and only the coin\'s own claim status comes back', async () => {
  let reads = 0
  const handler = createNativeClaimHandler({ ...options, runtime: () => ({ origin: 'https://repo.ing', status: async m => { reads++; return { mint: m, native: true, creator: owner, claimableLamports: '5625000' } } }) })
  const value = await json(await handler(request({ action: 'status', mint }, { cookie: '' })))
  assert.deepEqual(value, { status: 'available', claim: { mint, native: true, creator: owner, claimableLamports: '5625000' } })
  await handler(request({ action: 'status', mint })); assert.equal(reads, 1, 'repeated reads share a short cache')
})

test('HTTP cannot inject owners, amounts, observations or another stage; claims need the session', async () => {
  let calls = 0
  const handler = createNativeClaimHandler({ ...options, runtime: () => { calls++; return { origin: 'https://repo.ing', status: async () => null, lifecycle: {} } } })
  for (const [req, status] of [[request({ action: 'status', mint }, { origin: 'https://wrong.invalid' }), 403], [request({ action: 'claim', signingId: id, mint, owner }), 400],
    [request({ action: 'claim', signingId: id, mint, lamports: '1' }), 400], [request({ action: 'claim', signingId: id, mint, observations: [] }), 400],
    [request({ action: 'claim', signingId: id, mint: 'not-a-key' }), 400], [request({ action: 'cosign', signingId: id }), 400], [request({ action: 'refresh-review', signingId: id }), 400],
    [request({ action: 'status', mint }, {}, 'https://repo.ing/api/hook-lab/native-claim?mint=x'), 400]]) assert.equal((await handler(req)).status, status)
  assert.equal(calls, 0)
  assert.equal((await handler(request({ action: 'claim', signingId: id, mint }, { cookie: '' }))).status, 401)
})

test('claim creates a native-claim review for the session wallet; any other stage is refused; refusals read plainly', async () => {
  const seen = [], lifecycle = { createReview: async (t, i, value) => { seen.push([t, i, value]); return { id, owner, stage: 'native-claim', status: 'reviewed', review: { messageBase64: 'NEVER-UNMARKED', messageSha256: 'a'.repeat(64) } } },
    get: async () => ({ id, owner, stage: 'inclusive-buy', status: 'reviewed', review: {} }) }
  const handler = createNativeClaimHandler({ ...options, runtime: () => ({ origin: 'https://repo.ing', status: async () => null, lifecycle }) })
  const created = await json(await handler(request({ action: 'claim', signingId: id, mint })))
  assert.deepEqual(seen, [[token, id, { custodyOperationId: id, stage: 'native-claim', intent: { mint } }]])
  assert.equal(created.operation.stage, 'native-claim'); assert.ok(!JSON.stringify(created).includes('NEVER-UNMARKED'), 'signable bytes only through wallet-request')
  assert.equal((await handler(request({ action: 'get', signingId: id }))).status, 409, 'a trade operation is not a claim')

  const refusing = message => createNativeClaimHandler({ ...options, runtime: () => ({ origin: 'https://repo.ing', status: async () => null,
    lifecycle: { createReview: async () => { throw Object.assign(Error(message), { code: 'HOOKLAB_USER_REFUSAL' }) } } }) })
  const shown = await refusing('Nothing to claim yet. Fees arrive with every buy and sell of your coin.')(request({ action: 'claim', signingId: id, mint }))
  assert.equal(shown.status, 409); assert.match((await json(shown)).error, /Nothing to claim yet/)
  const masked = await createNativeClaimHandler({ ...options, runtime: () => ({ origin: 'https://repo.ing', status: async () => null, lifecycle: { createReview: async () => { throw Error('RPC SECRET') } } }) })(request({ action: 'claim', signingId: id, mint }))
  assert.ok(!(await masked.text()).includes('SECRET'))
})
