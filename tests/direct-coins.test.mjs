import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Connection, PublicKey } from '@solana/web3.js'
import { defaultDirectPlan, previewDirectCoin, DEVNET_GENESIS, HOOK_AUTHORITY } from '../src/direct-coins.mjs'
import { directCoinAdapter } from '../src/direct-coin-adapters.mjs'
import { directRequestSchema } from '../src/direct-coin-drafts.mjs'
import { loadDirectDraft, saveDirectDraft } from '../app/lib/direct-coin-draft.mjs'

test('lane/standard/quote/LP/recipe boundaries refuse unsupported plans without claiming simulation or execution', () => {
  for (const adapter of ['raydium', 'meteora-dbc', 'meteora-damm', 'hooklab']) {
    const plan = { ...defaultDirectPlan(adapter === 'hooklab' ? 'programmable' : 'standard'), adapter, name: 'Boundary Coin', symbol: 'BOUND' }
    const client = directCoinAdapter(adapter)
    assert.equal(client.preview(plan).compatible, true)
    for (const patch of [{ network: 'mainnet-beta' }, { lane: plan.lane === 'standard' ? 'programmable' : 'standard' },
      { standard: 'token-2022' }, { quote: 'usdc' }, { lpPolicy: 'burn' }, { lpPolicy: 'lock' }, { lpPolicy: 'creator' }, { recipe: 'lottery' }, { recipe: 'custom' }]) {
      const preview = client.preview({ ...plan, ...patch })
      assert.equal(preview.compatible, false, `${adapter}: ${JSON.stringify(patch)}`)
      assert.ok(preview.refusals.length)
      assert.equal(preview.canSubmit, false)
      assert.equal(preview.canSign, false)
      assert.equal(preview.quote, null)
      assert.equal(preview.simulation.status, 'not-run')
    }
    assert.equal(client.preview({ ...plan, recipe: 'kit' }).compatible, false)
    assert.equal(client.preview({ ...plan, recipe: 'halfLife' }).compatible, false)
    assert.throws(() => client.buildTransaction(plan), /disabled/)
  }
  assert.throws(() => directCoinAdapter('constructor'), /Unknown adapter/)
  assert.equal(defaultDirectPlan().adapter, 'raydium')
  assert.match(previewDirectCoin(defaultDirectPlan('programmable')).venue.authority, /not SPL/)
})

test('strict requests reject secret/transaction/RPC injection, unknown actions and partial draft revisions', () => {
  const base = { action: 'save', plan: defaultDirectPlan() }
  assert.equal(directRequestSchema.safeParse(base).success, true)
  for (const input of [{ ...base, secretKey: 'never accepted' }, { ...base, transaction: 'bytes' }, { ...base, action: 'send' },
    { ...base, plan: { ...base.plan, rpcUrl: 'http://example.invalid' } }, { ...base, revision: 1 },
    { ...base, id: '89130bd7-12a8-46cc-b604-ecc8585939ab' }, { ...base, plan: { ...base.plan, symbol: 'BAD<script>' } },
    { action: 'inspect', plan: base.plan }, { action: 'inspect', plan: base.plan, confirmedNetwork: 'mainnet-beta' }]) {
    assert.equal(directRequestSchema.safeParse(input).success, false)
  }
})

test('Solana RPC adapter decodes program identities/authorities; missing programs and wrong genesis fail closed', async () => {
  let genesis = DEVNET_GENESIS, missing = false
  const loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
  const dataAddress = new PublicKey('3AWwgBXJfCT2D4jMYjYpbrGgxhLhcgVkreYzeQeF9mpM')
  const program = Buffer.alloc(36); program.writeUInt32LE(2); dataAddress.toBuffer().copy(program, 4)
  const data = Buffer.alloc(45); data.writeUInt32LE(3); data[12] = 1; new PublicKey(HOOK_AUTHORITY).toBuffer().copy(data, 13)
  const account = (bytes, executable) => ({ data: [bytes.toString('base64'), 'base64'], executable, owner: loader, lamports: 1, rentEpoch: 0 })
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    const result = body.method === 'getGenesisHash' ? genesis : body.method === 'getMultipleAccounts'
      ? { context: { slot: 12345 }, value: body.params[0].map((_, i) => missing && i === 1 ? null : account(program, true)) }
      : body.method === 'getAccountInfo' ? { context: { slot: 12346 }, value: account(data, false) } : null
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(result === null ? { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Only read methods allowed' } } : { jsonrpc: '2.0', id: body.id, result }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const connection = new Connection(`http://127.0.0.1:${server.address().port}`)
    const adapter = directCoinAdapter('raydium'), plan = defaultDirectPlan()
    await assert.rejects(adapter.inspect(plan, { connection }), /confirmation/)
    const options = { connection, confirmedNetwork: 'devnet' }
    const read = await adapter.inspect(plan, options)
    assert.equal(read.status, 'programs-present')
    assert.equal(read.programs.length, 2)
    assert.equal(read.programs[0].upgradeAuthority, HOOK_AUTHORITY)
    assert.equal(read.programs[0].programData, dataAddress.toBase58())
    assert.equal(read.slot, 12345)
    assert.equal(read.canSubmit, false)
    missing = true
    assert.equal((await adapter.inspect(plan, options)).status, 'missing-programs')
    genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
    await assert.rejects(adapter.inspect(plan, options), /not Solana devnet/)
    await assert.rejects(adapter.inspect({ ...plan, network: 'mainnet-beta' }, options), /Mainnet is not enabled/)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('fresh native adapter refuses legacy recipes, missing deployments and unknown costs without enabling execution', async () => {
  const adapter = directCoinAdapter('hooklab')
  const plan = { ...defaultDirectPlan('programmable'), name: 'Native Coin', symbol: 'NATIVE' }
  let genesis = DEVNET_GENESIS
  const connection = {
    getGenesisHash: async () => genesis,
    getMultipleAccountsInfoAndContext: async keys => ({ context: { slot: 511377600 }, value: keys.map(() => null) }),
  }
  const options = { confirmedNetwork: 'devnet', connection }
  await assert.rejects(adapter.inspect(plan, { connection }), /confirmation/)
  const missingParameters = await adapter.inspect(plan, options)
  assert.equal(missingParameters.native.intent, null)
  assert.match(missingParameters.native.intentRefusals[0], /no fee is inferred/)
  for (const recipe of ['kit', 'halfLife']) await assert.rejects(adapter.inspect({ ...plan, recipe, creatorFeeBps: 0 }, options), /Only plain/)
  await assert.rejects(adapter.inspect({ ...plan, creatorFeeBps: 137 }, options), /zero creator fee/)
  const zero = await adapter.inspect({ ...plan, creatorFeeBps: 0 }, options)
  assert.equal(zero.status, 'refused')
  assert.equal(zero.slot, 511377600)
  assert.ok(zero.native.inspection.refusals.some(r => r.subject === 'swap'))
  assert.ok(zero.native.inspection.refusals.some(r => r.subject === 'launch'))
  assert.equal(zero.native.intent.recipe, 'plain')
  assert.ok(zero.native.intent.refusals.some(r => r.code === 'INSPECTION_INCOMPATIBLE'))
  for (const key of ['exactWalletDebitLamports', 'rentLamports', 'networkFeeLamports', 'minOutputRaw', 'expiry']) assert.equal(zero.native.intent[key], null)
  assert.deepEqual(zero.native.intent.steps, [])
  assert.equal(zero.canSubmit, false)
  assert.equal(zero.simulation.status, 'not-run')
  const unicode = await adapter.inspect({ ...plan, name: '界'.repeat(12), creatorFeeBps: 0 }, options)
  assert.ok(unicode.native.intent.refusals.some(r => /UTF-8 bytes/.test(r.message)))
  genesis = 'wrong-network'
  const wrong = await adapter.inspect({ ...plan, creatorFeeBps: 0 }, options)
  assert.equal(wrong.status, 'refused')
  assert.equal(wrong.slot, null)
  assert.ok(wrong.native.inspection.refusals.some(r => r.subject === 'network'))
  connection.getGenesisHash = async () => { throw new Error('sensitive RPC URL must not escape') }
  const unavailable = await adapter.inspect(plan, options)
  assert.equal(unavailable.status, 'unavailable')
  assert.ok(!JSON.stringify(unavailable).includes('sensitive RPC URL'))
  assert.throws(() => adapter.buildTransaction(plan), /disabled/)
})

test('device drafts preserve both lanes and legacy parameters; richer unknown recipes are never truncated', () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  const standard = { ...defaultDirectPlan(), name: 'Legacy', symbol: 'OLD', adapter: 'meteora-dbc' }
  values.set('repoing.direct-coin.v1', JSON.stringify(standard))
  assert.equal(loadDirectDraft(storage, 'programmable').lane, 'programmable')
  const native = { ...defaultDirectPlan('programmable'), name: 'Native', symbol: 'NATIVE', recipe: 'kit', creatorFeeBps: 137, kitMaxWalletBps: 850 }
  saveDirectDraft(storage, native)
  assert.deepEqual(loadDirectDraft(storage, 'standard'), standard)
  assert.deepEqual(loadDirectDraft(storage), native)
  saveDirectDraft(storage, standard)
  assert.deepEqual(loadDirectDraft(storage, 'programmable'), native)
  const richer = JSON.stringify({ ...native, blocks: [{ type: 'burn', bps: 73 }] })
  values.set('repoing.direct-coin.v1.programmable', richer)
  assert.throws(() => loadDirectDraft(storage, 'programmable'))
  assert.equal(values.get('repoing.direct-coin.v1.programmable'), richer)
  assert.throws(() => saveDirectDraft(storage, JSON.parse(richer)))
  assert.equal(values.get('repoing.direct-coin.v1.programmable'), richer)
})

test('public inspection needs neither GitHub nor a database, but consent, origin, payload and rate limits still apply', async t => {
  const { POST } = await import('../app/api/direct-coins/route.js')
  const originBefore = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = 'https://repo.ing'
  t.after(() => { if (originBefore === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = originBefore })
  const plan = { ...defaultDirectPlan('programmable'), name: 'Public', symbol: 'PUB', creatorFeeBps: 0 }
  const input = { action: 'inspect', plan, confirmedNetwork: 'devnet' }
  const request = (body, origin = 'https://repo.ing') => {
    const req = new Request('https://repo.ing/api/direct-coins', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.197' }, body: JSON.stringify(body) })
    req.cookies = { get: () => undefined }
    return req
  }
  let reads = 0
  t.mock.method(Connection.prototype, 'getGenesisHash', async () => { reads++; return 'wrong-network' })
  t.mock.method(Connection.prototype, 'getMultipleAccountsInfoAndContext', async () => { throw new Error('Accounts must not be read after wrong genesis') })
  const oldLimiter = globalThis.__repoingRequestLimiter
  delete globalThis.__repoingRequestLimiter
  try {
    assert.equal((await POST(request(input, 'https://evil.invalid'))).status, 403)
    assert.equal((await POST(request({ ...input, confirmedNetwork: undefined }))).status, 400)
    assert.equal((await POST(request({ ...input, action: 'send' }))).status, 400)
    assert.equal((await POST(request({ ...input, launcherWallet: HOOK_AUTHORITY }))).status, 400)
    assert.equal((await POST(request({ action: 'save', plan }))).status, 401)
    assert.equal(reads, 0)
    const result = await POST(request(input)), body = await result.json()
    assert.equal(result.status, 200)
    assert.equal(body.audit, 'not-requested')
    assert.equal(body.observation.status, 'refused')
    assert.equal(body.observation.canSubmit, false)
    assert.ok(body.observation.native.inspection.refusals.some(r => r.subject === 'network'))
    assert.equal(reads, 1)
    for (let i = 0; i < 3; i++) assert.equal((await POST(request({ ...input, plan: { ...plan, network: 'mainnet-beta' } }))).status, 422)
    assert.equal((await POST(request(input))).status, 429)
    assert.equal(reads, 1)
  } finally { globalThis.__repoingRequestLimiter = oldLimiter }
})
