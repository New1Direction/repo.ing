import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { bindHookPublication, hookCatalogStore, hookPublicationInputSchema, hookSetupManifestSchema, materializeHookSetup, materializePostMintHoldingOwners, revalidateHookPublication, taxHookSetupManifest } from '../src/hooklab-hook-catalog.mjs'
import { selectedHookSetupRequestSchema } from '../src/hooklab-selected-hook-setup.mjs'
import { createHookCatalogHandler } from '../app/lib/hooklab-hook-catalog.mjs'

const address = n => new PublicKey(Buffer.alloc(32, n)).toBase58()
const creator = address(1), mint = address(2), collector = address(3), H = address(4), J = address(5)
const config = { feeBps: '125', maxWalletBps: '500', collector }
const evidence = program => ({ hookPin: { program, elfSha256: 'a'.repeat(64) }, authority: { kind: 'immutable' }, observedSlot: 10, providers: ['a','b'] })
const publication = (program = H) => ({ name: 'Transfer tax', version: '1.0', selectedHook: { program, flags: 65 }, behavior: 'Caps wallets and taxes transfers.', fees: '125 bps, destination inclusive.', risks: 'Collector exempt; fees zero until holding exists.', manifest: taxHookSetupManifest({ program, flags: 65 }) })
// SQL adapter records actual public store operations, including unique/version conflicts.
function database() {
  const records = new Map()
  return { records, async end() {}, async query(sql, args = []) {
    if (sql.startsWith('insert')) {
      if ([...records.values()].some(r => r.publisher === args[1] && r.program === args[2] && r.version === args[3])) return { rows: [] }
      records.set(args[0], { digest: args[0], publisher: args[1], program: args[2], version: args[3], publication: JSON.parse(args[4]) }); return { rows: [{ digest: args[0] }] }
    }
    if (sql.includes('where publisher=')) return { rows: [...records.values()].filter(r => r.publisher === args[0] && r.program === args[1] && r.version === args[2]) }
    if (sql.includes('where digest=')) return { rows: records.has(args[0]) ? [records.get(args[0])] : [] }
    if (sql.startsWith('select digest,')) return { rows: [...records.values()] }
    throw Error('Unexpected SQL')
  } }
}
test('tax prepare template matches pinned discriminator, u16 layout, account order and PDAs', () => {
  const manifest = taxHookSetupManifest({ program: H, flags: 65 }), before = structuredClone(manifest)
  const result = materializeHookSetup(manifest, config, { creator, mint }), ix = result.instructions[0]
  assert.deepEqual(selectedHookSetupRequestSchema.parse(result), result)
  const expected = Buffer.concat([createHash('sha256').update('global:prepare').digest().subarray(0, 8), Buffer.from([125,0,244,1])])
  assert.equal(ix.dataBase64, expected.toString('base64'))
  const pda = seed => PublicKey.findProgramAddressSync([Buffer.from(seed), new PublicKey(mint).toBuffer()], new PublicKey(H))[0].toBase58()
  assert.deepEqual(ix.accounts.map(a => a.address), [creator, mint, collector, pda('tax'), pda('bordrless-hook-accounts'), '11111111111111111111111111111111'])
  assert.deepEqual(ix.accounts.filter(a => a.signer).map(a => a.address), [creator])
  assert.deepEqual(manifest, before)
  assert.throws(() => { result.instructions[0].accounts[0].address = collector }, TypeError)
})
test('tax launch creates both fee recipients atomically and merges an identical owner', () => {
  const platform = 'FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i'
  const manifest = taxHookSetupManifest({ program: H, flags: 65 })
  const owners = configuration => materializePostMintHoldingOwners({ digest: 'a'.repeat(64), manifest, configuration }, { creator, mint, selectedHook: manifest.selectedHook })
  assert.deepEqual(owners(config), [collector, platform])
  assert.deepEqual(owners({ ...config, collector: platform }), [platform])
})
test('unsafe manifests/config cannot inject JS, programs, extra signers, writable mint or mixed program', () => {
  for (const mutate of [m => { m.javascript = 'fetch()' }, m => { m.instructions[0].program = J }, m => { m.instructions[0].accounts[2].signer = true }, m => { m.instructions[0].accounts[1].writable = true }, m => { m.instructions[0].data.push({ kind: 'field', name: 'unknown' }) }, m => { m.fields[0].max = '65536' }]) {
    const m = structuredClone(publication().manifest); mutate(m); assert.equal(hookSetupManifestSchema.safeParse(m).success, false)
  }
  const p = publication(); p.manifest.selectedHook.program = J
  assert.equal(hookPublicationInputSchema.safeParse(p).success, false)
  for (const c of [{ ...config, feeBps: '2001' }, { ...config, feeBps: '01' }, { ...config, feeBps: 1 }, { ...config, injected: true }, { ...config, collector: mint }]) assert.throws(() => materializeHookSetup(publication().manifest, c, { creator, mint }))
})
test('two unrelated hook programs publish and discover without release IDs; versions are append-only', async () => {
  const pool = database(), store = hookCatalogStore(pool)
  const a = await store.publish(creator, publication(H), evidence(H)), b = await store.publish(collector, publication(J), { ...evidence(J), authority: { kind: 'timelocked' } })
  assert.notEqual(a.digest, b.digest)
  const list = await store.list(); assert.deepEqual(list.map(p => p.selectedHook.program), [H,J]); assert.equal(list[0].publisher, creator); assert.equal(list[0].evidence, undefined)
  await assert.rejects(store.publish(creator, { ...publication(), fees: 'Changed silently' }, evidence(H)), /new version/)
  assert.equal((await store.get(a.digest)).fees, publication().fees)
  const v2 = await store.publish(creator, { ...publication(), version: '2', fees: 'New terms' }, evidence(H)); assert.notEqual(a.digest, v2.digest)
  pool.records.get(a.digest).publication.manifest.fields[0].max = '1999'
  await assert.rejects(store.get(a.digest), /commitment/)
})
test('binding rejects manifest/program drift and freezes creator config; execution rejects executable drift', async () => {
  const store = hookCatalogStore(database()), p = await store.publish(creator, publication(), evidence(H))
  const calls = [], observe = async input => { calls.push(input); return { ...evidence(H), observedSlot: 11 } }
  const selection = { digest: p.digest, manifest: p.manifest, configuration: { ...config } }, input = { store, observe, selection, selectedHook: p.selectedHook, creator, mint }
  const bound = await bindHookPublication(input); selection.configuration.feeBps = '200'
  assert.equal(bound.hookPublication.configuration.feeBps, '125'); assert.equal(calls[0].expectedEvidence.hookPin.program, H)
  assert.throws(() => { bound.hookPublication.configuration.feeBps = '300' }, TypeError)
  await assert.rejects(bindHookPublication({ ...input, selectedHook: { program: J, flags: 65 } }), /differs/)
  const changed = structuredClone(selection); changed.manifest.fields[0].max = '1999'
  await assert.rejects(bindHookPublication({ ...input, selection: changed }), /differs/)
  await assert.rejects(revalidateHookPublication({ store, digest: p.digest, observe: async () => ({ ...evidence(H), hookPin: { program: H, elfSha256: 'b'.repeat(64) } }) }), /changed/)
})
function harness(overrides = {}) {
  const pool = database(), observations = [], token = Buffer.alloc(32, 7).toString('base64url')
  const handler = createHookCatalogHandler({ env: { HOOK_WALLET_IDENTITY_ENABLED: 'true' }, configuration: () => ({ origin: 'https://repo.ing', audience: 'test', genesisHash: 'test' }), database: () => pool,
    principalStore: () => ({ resolve: async value => { assert.equal(value, token); return { wallet: creator } } }), quota: async () => true,
    observe: async input => { observations.push(input); return evidence(input.program) }, ...overrides })
  const request = (body, headers = {}) => new Request('https://repo.ing/api/hook-lab/hook-catalog', { method: body ? 'POST' : 'GET', headers: { origin: 'https://repo.ing', 'content-type': 'application/json', cookie: `__Host-hook-wallet-session=${token}`, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { handler, request, observations, pool }
}
test('handler wallet-authenticates publication, publicly lists and revalidates selection', async () => {
  const { handler, request, observations } = harness()
  for (const program of [H,J]) assert.equal((await handler(request({ action: 'publish', publication: publication(program) }))).status, 201)
  const result = await handler(request(null, { cookie: '' })); assert.equal(result.status, 200)
  const list = await result.json(); assert.equal(list.publications.length, 2); assert.match(list.notice, /not endorsement/)
  assert.equal(list.publications[0].publisher, creator)
  const selected = await handler(request({ action: 'select', digest: list.publications[0].digest })); assert.equal(selected.status, 200)
  assert.equal(observations[2].expectedEvidence.hookPin.program, H)
})
test('handler rejects CSRF, missing/expired auth, malformed payloads, evidence spoofing and quotas before observation', async () => {
  const { handler, request, observations } = harness(), body = { action: 'publish', publication: publication() }
  for (const headers of [{ origin: 'https://evil.invalid' }, { 'sec-fetch-site': 'cross-site' }, { host: 'evil.invalid' }]) assert.equal((await handler(request(body, headers))).status, 403)
  assert.equal((await handler(request(body, { cookie: '' }))).status, 401)
  assert.equal((await handler(request(body, { 'content-type': 'text/plain' }))).status, 415)
  assert.equal((await handler(request({ ...body, evidence: evidence(H) }))).status, 400)
  assert.equal((await handler(request({ ...body, publication: { ...body.publication, publisher: collector } }))).status, 400)
  assert.equal(observations.length, 0)
  const expired = harness({ principalStore: () => ({ resolve: async () => { throw Object.assign(Error(), { status: 401 }) } }) })
  assert.equal((await expired.handler(expired.request(body))).status, 401)
  const limited = harness({ quota: async () => false }); assert.equal((await limited.handler(limited.request(body))).status, 429)
})
test('missing observer support and unbounded authorities fail closed', async () => {
  const body = { action: 'publish', publication: publication() }
  for (const observe of [async () => { throw Error('unavailable') }, async () => ({ ...evidence(H), authority: { kind: 'wallet' } })]) {
    const { handler, request, pool } = harness({ observe }); assert.equal((await handler(request(body))).status, 409); assert.equal(pool.records.size, 0)
  }
})
