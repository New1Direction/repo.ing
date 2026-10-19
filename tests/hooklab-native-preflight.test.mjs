// The native-SOL upgrade preflight against real program-written accounts (hook-lab scripts/fixtures at e357fdf, made by
// native_launch.rs s6_preflight_fixture_accounts in a disposable bank over retained public state) and their hook-less
// layouts: the same verdicts as hook-lab's verify_native_preflight.py. Scripted providers; no RPC.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { checkNativePreflight, scanNativePreflight } from '../src/hooklab-native-preflight.mjs'

const bytes = readFileSync(new URL('./fixtures/hooklab-native-preflight-accounts.json', import.meta.url))
const fixture = JSON.parse(bytes), rows = Object.fromEntries(fixture.accounts.map(r => [r.label, { pubkey: r.pubkey, owner: r.owner, data: Buffer.from(r.dataBase64, 'base64'), native: r.native }]))
const check = (labels, config = rows['retained-launch-config']) => checkNativePreflight([...labels.map(l => rows[l]), ...(config ? [config] : [])])
const withByte = (row, offset, value) => { const data = Buffer.from(row.data); data[offset] = value; return { ...row, data } }
// The same account with its Option tag None: the 32 key bytes removed, the tail zero-padded, the flag moved with the bytes.
const withoutHook = (row, tagAt) => ({ ...row, data: Buffer.concat([row.data.subarray(0, tagAt), Buffer.from([0]), row.data.subarray(tagAt + 33), Buffer.alloc(32)]) })

test('the fixture is hook-lab\'s, byte for byte', () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'b5c576ef5ceafc78fce079b38877bbf6c5c81af96d869433297f44d7259038f5')
  assert.equal(fixture.schema, 'hook-lab/native-preflight-fixture/1')
})

test('bridged accounts pass; native ones fail by key; the flags sit where the upgrade puts them', () => {
  const clean = check(['bridged-pool', 'bridged-launch'])
  assert.equal(clean.ok, true); assert.deepEqual([clean.pools, clean.launches], [1, 1]); assert.deepEqual(clean.launchConfig.reservedNonzero, [])
  const dirty = check(['bridged-pool', 'bridged-launch', 'native-pool', 'native-launch'])
  assert.equal(dirty.ok, false); assert.deepEqual(dirty.nativePools, [rows['native-pool'].pubkey]); assert.deepEqual(dirty.nativeLaunches, [rows['native-launch'].pubkey])
  for (const [label, offset, value] of [['bridged-pool', 351, 0], ['native-pool', 351, 1], ['bridged-launch', 560, 0], ['native-launch', 560, 1]]) assert.equal(rows[label].data[offset], value, label)
})

test('hook-less layouts are read at 319 and 528', () => {
  for (const [label, tagAt] of [['bridged-pool', 171], ['native-pool', 171], ['bridged-launch', 498], ['native-launch', 498]])
    assert.equal(checkNativePreflight([withoutHook(rows[label], tagAt), rows['retained-launch-config']]).ok, !rows[label].native, label)
})

test('a malformed option tag fails closed; other owners and layouts are ignored', () => {
  const bad = withByte(rows['bridged-pool'], 171, 2), report = checkNativePreflight([bad, rows['retained-launch-config']])
  assert.equal(report.ok, false); assert.deepEqual(report.malformed, [bad.pubkey])
  const foreign = checkNativePreflight([{ ...rows['native-pool'], owner: '11111111111111111111111111111111' }, rows['retained-launch-config']])
  assert.equal(foreign.ok, true); assert.equal(foreign.pools, 0)
})

test('the launch Config: the switch, any other reserved byte, or no config at all fails', () => {
  assert.deepEqual([rows['retained-launch-config'].data.length, rows['retained-launch-config'].data[186]], [250, 0])
  const on = check(['bridged-pool', 'bridged-launch'], withByte(rows['retained-launch-config'], 186, 1))
  assert.equal(on.ok, false); assert.deepEqual(on.launchConfig.reservedNonzero, [186]); assert.ok(on.reasons.some(r => /186.*switch/.test(r)), on.reasons)
  const other = check(['bridged-pool'], withByte(rows['retained-launch-config'], 249, 7))
  assert.equal(other.ok, false); assert.deepEqual(other.launchConfig.reservedNonzero, [249])
  const missing = check(['bridged-pool', 'bridged-launch'], null)
  assert.equal(missing.ok, false); assert.ok(missing.reasons.some(r => /launch config/.test(r)))
})

test('the scan reads every Pool, Launch and the Config from both providers, and refuses when they disagree', async () => {
  const provider = accounts => ({ connection: {
    getProgramAccounts: async (program, options) => {
      assert.equal(options.commitment, 'finalized'); assert.equal(options.filters.length, 2)
      return accounts.filter(a => a.owner === program.toBase58() && a.data.length === options.filters[0].dataSize).map(a => ({ pubkey: new PublicKey(a.pubkey), account: { owner: new PublicKey(a.owner), data: a.data } }))
    },
    getAccountInfo: async (address, commitment) => { assert.equal(commitment, 'finalized'); const a = accounts.find(x => x.pubkey === address.toBase58()); return a ? { owner: new PublicKey(a.owner), data: a.data } : null } } })
  const before = [rows['bridged-pool'], rows['bridged-launch'], rows['retained-launch-config']]
  const scanned = await scanNativePreflight([{ provider: 'primary', ...provider(before) }, { provider: 'secondary', ...provider(before) }])
  assert.equal(scanned.ok, true); assert.deepEqual(scanned.providers, ['primary', 'secondary'])
  const after = [...before, rows['native-pool']]
  assert.equal((await scanNativePreflight([{ provider: 'primary', ...provider(after) }, { provider: 'secondary', ...provider(after) }])).ok, false)
  await assert.rejects(scanNativePreflight([{ provider: 'primary', ...provider(before) }, { provider: 'secondary', ...provider(after) }]), /providers disagree/)
})
