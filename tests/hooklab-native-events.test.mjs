import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { productionHookEventDecoder } from '../src/hooklab-native-events.mjs'
import { indexHookNativeBatch } from '../src/hooklab-native-indexer.mjs'
import { nativeIndexFixture, key } from './fixtures/hooklab-native-index.mjs'

const decoder = productionHookEventDecoder(), swap = decoder.programs[1]
function receipt(swapProgram = swap) {
  const swap = swapProgram
  const authority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], new PublicKey(swap))[0].toBase58()
  // Independently laid out ProtocolFeesCollected: pool, u64 quote_amount, collector, i64 ts.
  const body = Buffer.alloc(80)
  Buffer.alloc(32, 6).copy(body); body.writeBigUInt64LE(9007199254740993n, 32)
  Buffer.alloc(32, 7).copy(body, 40); body.writeBigInt64LE(-7n, 72)
  const data = Buffer.concat([Buffer.from('e445a52e51cb9a1da5227d9b0f5663bf', 'hex'), body])
  return { version: 0, transaction: { signatures: [bs58.encode(Buffer.alloc(64, 5))], message: {
    accountKeys: [key(2), swap], addressTableLookups: [{ accountKey: key(4), writableIndexes: [], readonlyIndexes: [0] }],
    instructions: [{ programIdIndex: 0, accounts: [], data: '' }],
  } }, meta: { err: null, fee: 5000, preBalances: [10000, 1, 1], postBalances: [5000, 1, 1],
    loadedAddresses: { writable: [], readonly: [authority] },
    innerInstructions: [{ index: 0, instructions: [
      { programIdIndex: 1, accounts: [], data: '', stackHeight: 2 },
      { programIdIndex: 1, accounts: [2], data: bs58.encode(data), stackHeight: 3 },
    ] }],
  } }
}

test('pinned production ABI decodes nested self-CPI/ALT and preserves exact raw integers without acceptance', () => {
  const raw = receipt(), out = decoder.decode(raw)
  assert.deepEqual(out.events, [{ program: swap, outerIndex: 0, innerIndex: 1, name: 'ProtocolFeesCollected',
    data: { pool: key(6), quote_amount: '9007199254740993', collector: key(7), ts: '-7' }, transactionFailed: false }])
  assert.equal(out.economicPostconditions, false); assert.equal(out.deploymentAdopted, false)
  raw.meta.err = { InstructionError: [0, 'Custom'] }
  assert.equal(decoder.decode(raw).events[0].transactionFailed, true)
  raw.meta.innerInstructions = []; raw.meta.logMessages = ['Program log: ProtocolFeesCollected']
  assert.deepEqual(decoder.decode(raw).events, [])
})

test('spoofed parent/authority, missing ancestry, unknown or trailing bytes cannot become decoded events', () => {
  for (const change of [
    r => { r.meta.innerInstructions[0].instructions[0].programIdIndex = 0 },
    r => { r.meta.innerInstructions[0].instructions[1].accounts = [0] },
    r => { delete r.meta.innerInstructions[0].instructions[0].stackHeight },
    r => { const i = r.meta.innerInstructions[0].instructions[1]; i.data = bs58.encode(Buffer.concat([bs58.decode(i.data), Buffer.from([0])])) },
    r => { const i = r.meta.innerInstructions[0].instructions[1], b = bs58.decode(i.data); b[8] ^= 1; i.data = bs58.encode(b) },
  ]) {
    const raw = receipt(); change(raw); assert.throws(() => decoder.decode(raw))
  }
})

test('decoder binding and malformed self-CPI stop the index checkpoint; valid receipts remain unadopted', async () => {
  const f = nativeIndexFixture()
  Object.assign(f.manifest, { sourceCommit: decoder.sourceCommit, idlSha256: decoder.idlSha256, programs: [swap] })
  f.blocks.get(100).transactions = [receipt()]
  let committed
  const store = { load: async () => ({ nextSlot: 100, lastBlock: null }), commit: async b => { committed = b } }
  await indexHookNativeBatch({ ...f, store, decoder })
  assert.equal(committed.rows.length, 1)
  assert.equal(committed.rows[0].receiptStatus, 'finalized-success')
  assert.equal(committed.rows[0].eventStatus, 'decoded-self-cpi')
  assert.equal(committed.rows[0].deploymentAdopted, false)
  committed = null
  f.blocks.get(100).transactions[0].meta.innerInstructions[0].instructions[1].accounts = [0]
  await assert.rejects(indexHookNativeBatch({ ...f, store, decoder }), /Unauthenticated/)
  assert.equal(committed, null)
  f.manifest.idlSha256 = '0'.repeat(64)
  await assert.rejects(indexHookNativeBatch({ ...f, store, decoder }), /binding differs/)
})

test('new custom-production addresses require their explicit source pin and still cannot imply adoption', () => {
  const custom = productionHookEventDecoder({ sourceCommit: '823442c7a7c3572ddf8ecf82c8084591ebb170c9' })
  const raw = receipt(custom.programs[1])
  assert.deepEqual(decoder.decode(raw).events, [])
  const decoded = custom.decode(raw)
  assert.equal(decoded.events[0].program, '4MsvuuDtsAsdGcSz7NWfSRtMZYcXXLrU4LNeT9MKeiKE')
  assert.equal(decoded.events[0].data.quote_amount, '9007199254740993')
  assert.equal(decoded.economicPostconditions, false)
  assert.equal(decoded.deploymentAdopted, false)
  assert.deepEqual(custom.decode(receipt()).events, [])
  assert.notEqual(custom.idlSha256, decoder.idlSha256)
  assert.throws(() => productionHookEventDecoder({ sourceCommit: 'f3062dfc1133ae1b0cb3d2f4d9d41145a4677a32' }), /Unpinned/)
})

test('all four ABI byte pins and program identities remain explicit and distinct', () => {
  const pins = [
    ['bordrless_launch.json', 'E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft', '929403a199c9cb411d25980a49667f531612efcdb7e449b13af9258b638869fb'],
    ['bordrless_swap.json', 'B2crxUdFwow36hy2KDbkiQro75mtLA4cN4pwDeQpZJwk', 'ba5409de62f8d56f3500a72f5b7d11cfdefd85027d2ec3bd56e2137ae76bc414'],
    ['custom-production/bordrless_launch.json', 'Ky5HeYrE3HK3oh5x2kGzHFpkxnQXHcXQLFAZPzkcvSG', '9240ff013753c9ab893663f7b89279f1e5f1baade080f8fbf61f4f07a6a15c57'],
    ['custom-production/bordrless_swap.json', '4MsvuuDtsAsdGcSz7NWfSRtMZYcXXLrU4LNeT9MKeiKE', '93a6721f59989c30423d7ad5a99cfd4592a9fd001160429bc063d74085fe2e13'],
  ]
  for (const [file, program, hash] of pins) {
    const bytes = readFileSync(new URL(`../vendor/hooklab-event-abi/${file}`, import.meta.url))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash)
    assert.equal(JSON.parse(bytes).address, program)
  }
  assert.equal(new Set(pins.map(p => p[1])).size, 4)
})

test('unknown decoder options and manifest fields fail before RPC or checkpoint access', async () => {
  for (const options of [null, [], { idl: {} }, { sourceCommit: decoder.sourceCommit, program: swap },
    { sourceCommit: decoder.sourceCommit, executionEnabled: true }]) {
    assert.throws(() => productionHookEventDecoder(options), /Unknown event decoder options/)
  }
  for (const unknown of [{ executionEnabled: true }, { deploymentAdopted: true }, { idl: {} }, { rpcUrl: 'https://rpc.invalid' }]) {
    const f = nativeIndexFixture()
    Object.assign(f.manifest, unknown)
    f.adapters = f.adapters.map(a => ({ ...a, read: () => assert.fail('must not read RPC') }))
    const store = { load: () => assert.fail('must not access checkpoint'), commit: () => assert.fail('must not commit') }
    await assert.rejects(indexHookNativeBatch({ ...f, store, decoder }))
  }
})

test('decoder output cannot overwrite receipt identity or promote economic/deployment evidence', async () => {
  for (const change of [
    out => { out.signature = 'substituted' },
    out => { out.receiptStatus = 'accepted-trade' },
    out => { out.economicPostconditions = true },
    out => { out.deploymentAdopted = true },
    out => { out.events[0].accepted = true },
  ]) {
    const f = nativeIndexFixture()
    Object.assign(f.manifest, { sourceCommit: decoder.sourceCommit, idlSha256: decoder.idlSha256, programs: [swap] })
    f.blocks.get(100).transactions = [receipt()]
    const unsafeDecoder = { ...decoder, decode(raw) { const out = decoder.decode(raw); change(out); return out } }
    const store = { load: async () => ({ nextSlot: 100, lastBlock: null }), commit: () => assert.fail('must not commit') }
    await assert.rejects(indexHookNativeBatch({ ...f, store, decoder: unsafeDecoder }))
  }
})

test('observer CLI requires explicit one-shot invocation and isolated configuration, with redacted failures', () => {
  const script = new URL('../scripts/index-hook-native.mjs', import.meta.url)
  const run = (args, env = {}) => spawnSync(process.execPath, [script.pathname, ...args], { env, encoding: 'utf8', timeout: 5000 })
  const noArgs = run([])
  assert.equal(noArgs.status, 2)
  assert.match(noArgs.stderr, /Usage:/)
  const directory = mkdtempSync(join(tmpdir(), 'hook-index-cli-'))
  try {
    const f = nativeIndexFixture()
    Object.assign(f.manifest, { sourceCommit: decoder.sourceCommit, idlSha256: decoder.idlSha256, programs: [swap] })
    const file = join(directory, 'manifest.json')
    const failures = [
      { manifest: f.manifest, env: { DATABASE_URL: 'do-not-use-default-database', SOLANA_RPC_URL: 'do-not-use-default-rpc' } },
      { manifest: { ...f.manifest, executionEnabled: true }, env: {} },
      { manifest: f.manifest, env: { HOOK_INDEX_DATABASE_URL: 'do-not-connect',
        HOOK_INDEX_RPC_ALPHA: 'https://same.invalid/private-a', HOOK_INDEX_RPC_BETA: 'https://same.invalid/private-b' } },
    ]
    for (const { manifest, env } of failures) {
      writeFileSync(file, JSON.stringify(manifest))
      const result = run(['--once', file], env)
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /Hook index batch failed or commit outcome unknown/)
      assert.doesNotMatch(result.stderr, /do-not-|same\.invalid|private-[ab]/)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('same-ID max-wallet ABI requires exact source patch and cannot imply adoption', async () => {
  const sourceCommit = 'a33957a3f4285351949852ce5fb49cb3616ef496'
  const sourcePatchSha256 = 'd1c5447d6e4c0400ad641679cb0e409425f2ce1ef9aaf6500611215f3491c13f'
  assert.throws(() => productionHookEventDecoder({ sourceCommit }), /patch binding/)
  assert.throws(() => productionHookEventDecoder({ sourceCommit, sourcePatchSha256: '0'.repeat(64) }), /patch binding/)
  assert.throws(() => productionHookEventDecoder({ sourceCommit: decoder.sourceCommit, sourcePatchSha256 }), /patch binding/)
  const candidate = productionHookEventDecoder({ sourceCommit, sourcePatchSha256 })
  assert.deepEqual(candidate.programs, decoder.programs)
  assert.notEqual(candidate.idlSha256, decoder.idlSha256)
  const out = candidate.decode(receipt())
  assert.equal(out.events[0].data.quote_amount, '9007199254740993')
  assert.equal(out.economicPostconditions, false)
  assert.equal(out.deploymentAdopted, false)
  const bytes = readFileSync(new URL('../vendor/hooklab-event-abi/max-wallet-reuse/bordrless_launch.json', import.meta.url))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'b1f564880120eac65ba7f35031260b74f93c9b5004edb55ce0543884fa6b5f8f')
  assert.equal(JSON.parse(bytes).address, candidate.programs[0])
  const f = nativeIndexFixture()
  Object.assign(f.manifest, { sourceCommit, sourcePatchSha256, idlSha256: candidate.idlSha256, programs: [swap] })
  f.blocks.get(100).transactions = [receipt()]
  let committed = null
  const store = { load: async () => ({ nextSlot: 100, lastBlock: null }), commit: async b => { committed = b } }
  await indexHookNativeBatch({ ...f, store, decoder: candidate })
  assert.equal(committed.rows[0].eventStatus, 'decoded-self-cpi')
  for (const patch of [undefined, '0'.repeat(64)]) {
    f.manifest.sourcePatchSha256 = patch
    await assert.rejects(indexHookNativeBatch({ ...f, store: { load: () => assert.fail('must not access checkpoint') }, decoder: candidate }), /binding differs/)
  }
})
