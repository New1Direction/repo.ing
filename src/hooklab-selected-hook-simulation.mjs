// Server-only read adapter. This measures token deltas; it does not authorize instructions or signing.
// A hook-specific compiler must supply conditions, program/registry pins and onchain debit/output guards.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { z } from 'zod'
import { hookAddress as key, hookDigest as digest, hookRawAmount as u64 } from './hooklab-execution-contract.mjs'
import { inspectHookLabMessage } from './hooklab-message-boundary.mjs'
import { assertLocalExecutionEndpoint } from './hooklab-local-acceptance.mjs'

const sha = x => createHash('sha256').update(x).digest('hex')
const check = x => { if (!x) throw Error('Selected-hook simulation evidence differs') }
const integer = x => { check(Number.isSafeInteger(x) && x >= 0); return x }
const pk = x => new PublicKey(x)
const bound = z.object({ address: key, maxDebit: u64, minCredit: u64 }).strict()
const conditionsSchema = z.object({ tokenProgram: key, configurationSha256: digest,
  holdings: z.array(bound.extend({ mint: key, owner: key }).strict()).max(64),
  native: z.array(bound).max(64), unchanged: z.array(z.object({ address: key, sha256: digest }).strict()).max(64),
}).strict()
const magic = Buffer.from(sha('account:Holding'), 'hex').subarray(0, 8)
function data(value) {
  check(Array.isArray(value) && value.length === 2 && value[1] === 'base64' && typeof value[0] === 'string')
  const b = Buffer.from(value[0], 'base64'); check(b.toString('base64') === value[0] && b.length <= 10485805)
  return b
}
function normalized(a, simulated = false) {
  if (a === null) return null
  check(a && typeof a.executable === 'boolean')
  const b = simulated ? data(a.data) : Buffer.from(a.data)
  return { owner: key.parse(simulated ? a.owner : a.owner.toBase58()), executable: a.executable,
    lamports: String(integer(a.lamports)), dataBase64: b.toString('base64') }
}
function holding(account, address, token, wanted) {
  if (!account) return 0n
  const b = Buffer.from(account.dataBase64, 'base64')
  check(account.owner === token && !account.executable && b.length === 204 && b.subarray(0, 8).equals(magic) && b[8] === 1)
  const mint = pk(b.subarray(10, 42)).toBase58(), owner = pk(b.subarray(42, 74)).toBase58()
  const [derived, bump] = PublicKey.findProgramAddressSync([Buffer.from('holding'), pk(mint).toBuffer(), pk(owner).toBuffer()], pk(token))
  check(derived.toBase58() === address && b[9] === bump && (!wanted || wanted.mint === mint && wanted.owner === owner))
  // This V1 adapter accepts no delegate/freeze/hook-data mutation of a principal's holding.
  check(b.subarray(82).every(x => x === 0))
  return b.readBigUInt64LE(74)
}
const within = (delta, limit) => check(delta >= -BigInt(limit?.maxDebit ?? '0') && (BigInt(limit?.minCredit ?? '0') === 0n || delta >= BigInt(limit.minCredit)))
const identity = result => ({ reviewSha256: result.reviewSha256, conditionsSha256: result.conditionsSha256,
  preStateSha256: result.preStateSha256, tokenDeltas: result.tokenDeltas, lamportDeltas: result.lamportDeltas })

/** Connections and conditions are server-owned. Never bind this adapter directly to HTTP JSON.
 * RPC has no atomic read-before-simulate API: require the same finalized bank for both reads,
 * and matching snapshots/deltas from two providers. A bank advance requires a fresh collection.
 * A successful simulation is evidence for one bank, never a guarantee about future execution.
 */
export async function collectSelectedHookSimulation({ review, conditions, connections, expected, clock = Date.now }) {
  try {
    const inspected = inspectHookLabMessage(review), r = inspected.review, c = conditionsSchema.parse(conditions)
    check(connections.length === 2 && connections[0].connection !== connections[1].connection
      && new Set(connections.map(x => x.provider)).size === 2)
    const urls = connections.map(x => x.connection.rpcEndpoint)
    if (urls.some(x => x !== undefined)) {
      check(urls.every(x => typeof x === 'string'))
      urls.forEach(assertLocalExecutionEndpoint)
      const parsed = urls.map(x => new URL(x))
      check(parsed.every(x => x.protocol === 'https:' && !x.username && !x.password && !x.hash)
        && parsed[0].origin !== parsed[1].origin)
    }
    const started = integer(clock()); check(started >= r.observedAtMs && started < r.reviewExpiresAtMs)
    const writable = r.accounts.filter(a => a.writable).map(a => a.address)
    const pins = [...c.unchanged, ...r.lookupTables.map(t => ({ address: t.address, sha256: t.sha256 }))]
    for (const list of [c.holdings, c.native, pins]) check(new Set(list.map(x => x.address)).size === list.length)
    check(c.holdings.every(x => writable.includes(x.address)) && c.native.every(x => writable.includes(x.address)))
    check(c.native.find(x => x.address === r.payer)?.maxDebit === r.maxNativeDebitLamports)
    check(pins.every(x => !writable.includes(x.address)))
    const addresses = [...new Set([...writable, ...pins.map(x => x.address)])]
    check(addresses.length > 0 && addresses.length <= 100)
    const message = VersionedMessage.deserialize(Buffer.from(r.messageBase64, 'base64'))
    const results = await Promise.all(connections.map(async ({ provider, connection }) => {
      check(await connection.getGenesisHash() === r.genesisHash)
      const pre = await connection.getMultipleAccountsInfoAndContext(addresses.map(pk), { commitment: 'finalized', minContextSlot: r.observedSlot })
      const slot = integer(pre.context.slot)
      check(slot >= r.observedSlot && slot <= r.validUntilSlot && pre.value.length === addresses.length)
      const before = pre.value.map(a => normalized(a))
      for (const pin of pins) {
        const a = before[addresses.indexOf(pin.address)]
        check(a && sha(Buffer.from(a.dataBase64, 'base64')) === pin.sha256)
      }
      const [valid, height, fee] = await Promise.all([
        connection.isBlockhashValid(message.recentBlockhash, { commitment: 'finalized', minContextSlot: slot }),
        connection.getBlockHeight({ commitment: 'finalized', minContextSlot: slot }), connection.getFeeForMessage(message, 'finalized'),
      ])
      check(valid.value === true && integer(valid.context.slot) >= slot && integer(height) <= r.lastValidBlockHeight
        && fee.value !== null && String(integer(fee.value)) === inspected.totalFeeLamports && integer(fee.context.slot) >= slot)
      const sim = await connection.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: false,
        commitment: 'finalized', minContextSlot: slot, accounts: { encoding: 'base64', addresses } })
      check(integer(sim.context.slot) === slot && sim.value.err === null && !sim.value.replacementBlockhash
        && integer(sim.value.unitsConsumed) > 0 && sim.value.unitsConsumed <= inspected.computeUnits && sim.value.accounts?.length === addresses.length)
      const after = sim.value.accounts.map(a => normalized(a, true)), tokenDeltas = {}, lamportDeltas = {}
      for (const [i, address] of addresses.entries()) {
        const a = before[i], b = after[i]
        if (pins.some(p => p.address === address)) { check(isDeepStrictEqual(a, b)); continue }
        const delta = BigInt(b?.lamports ?? '0') - BigInt(a?.lamports ?? '0')
        within(delta, c.native.find(x => x.address === address)); lamportDeltas[address] = String(delta)
        const wanted = c.holdings.find(x => x.address === address)
        const isHolding = v => v?.owner === c.tokenProgram && Buffer.from(v.dataBase64, 'base64').subarray(0, 8).equals(magic)
        if (wanted || isHolding(a) || isHolding(b)) {
          const amount = holding(b, address, c.tokenProgram, wanted) - holding(a, address, c.tokenProgram, wanted)
          check(b !== null); within(amount, wanted); tokenDeltas[address] = String(amount)
        }
      }
      check(integer(clock()) < r.reviewExpiresAtMs)
      return { provider, slot, before, after, tokenDeltas, lamportDeltas }
    }))
    const [one, two] = results
    check(one.slot === two.slot && isDeepStrictEqual(one.before, two.before) && isDeepStrictEqual(one.after, two.after))
    const result = { schema: 'repoing/selected-hook-simulation/1', messageSha256: r.messageSha256,
      reviewSha256: sha(JSON.stringify(r)), configurationSha256: c.configurationSha256, conditionsSha256: sha(JSON.stringify(c)),
      preStateSha256: sha(JSON.stringify(addresses.map((address, i) => ({ address, account: one.before[i] })))),
      providers: results.map(x => x.provider), simulationSlot: one.slot, tokenDeltas: one.tokenDeltas, lamportDeltas: one.lamportDeltas,
      canSign: false, canSubmit: false }
    if (expected) check(isDeepStrictEqual(identity(result), identity(expected)) && isDeepStrictEqual(result.providers, expected.providers))
    return Object.freeze(result)
  } catch {
    throw Object.assign(Error('Exact-message selected-hook simulation unavailable or changed; preserve the review and require new consent.'), { code: 'SELECTED_HOOK_SIMULATION_UNAVAILABLE' })
  }
}
