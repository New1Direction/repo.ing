// Server-owned launch context only. No signing, blockhash renewal or launch math.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { PublicKey } from '@solana/web3.js'
import { compileSelectedHookLaunchReview } from './hooklab-max-wallet-launch.mjs'
import { deriveOpenLaunchPostconditions } from './hooklab-max-wallet-launch-settlement.mjs'
import { inspectHookLabMessage } from './hooklab-message-boundary.mjs'
import { collectSelectedHookSimulation } from './hooklab-selected-hook-simulation.mjs'

const sha = x => createHash('sha256').update(x).digest('hex')
const check = x => { if (!x) throw Error('Selected launch simulation binding differs') }
const magic = Buffer.from(sha('account:Holding'), 'hex').subarray(0, 8)

export async function collectSelectedHookLaunchSimulation({ plan, settlementContext, configurationSha256, connections, expected, clock = Date.now }) {
  try {
    const ci = settlementContext.compilationInput
    check(connections.length === 2 && connections[0].connection !== connections[1].connection)
    check(settlementContext.schema === 'repoing/open-launch-settlement-context/1'
      && ci.request.policyKind === 'selected-hook' && settlementContext.configurationSha256 === configurationSha256)
    const compiled = compileSelectedHookLaunchReview(ci)
    // Collectors may retain the original observation timestamps on revalidation.
    const stable = r => { const { observedSlot, observedAtMs, policySha256, ...rest } = r; return rest }
    inspectHookLabMessage(plan.review)
    check(isDeepStrictEqual(stable(compiled.review), stable(plan.review)))
    const review = plan.review, writable = new Set(review.accounts.filter(x => x.writable).map(x => x.address))
    const tables = new Map(review.lookupTables.map(x => [x.address, x.sha256]))
    const observations = ci.observations.map(o => {
      check(new Set(o.accounts.map(x => x.address)).size === o.accounts.length)
      return new Map(o.accounts.map(x => [x.address, x.account]))
    })
    check(observations.length === 2)
    const pins = new Map()
    for (const [address, account] of observations[0]) {
      if (writable.has(address)) continue // Includes launch/swap counters and writable hook extras.
      check(observations[1].has(address) && isDeepStrictEqual(account, observations[1].get(address)))
      if (tables.has(address)) {
        check(account && sha(Buffer.from(account.dataBase64, 'base64')) === tables.get(address))
        continue
      }
      pins.set(address, account)
    }
    // ComputeBudget is a runtime builtin, omitted from the compiler's inventory.
    // It has no operator-selectable ProgramData/configuration to pin.
    for (const a of review.accounts.filter(x => !x.writable)) check(pins.has(a.address) || tables.has(a.address)
      || a.address === 'ComputeBudget111111111111111111111111111111')
    const post = deriveOpenLaunchPostconditions(settlementContext, { slot: review.observedSlot, timestamp: 0 })
    const tokenProgram = JSON.parse(ci.profile.json).programs.token
    const holdings = post.accounts.flatMap(a => {
      const b = Buffer.from(a.dataBase64, 'base64')
      if (a.owner !== tokenProgram || !b.subarray(0, 8).equals(magic)) return []
      check(b.length === 204 && b.subarray(82).every(x => x === 0) && observations.every(o => o.get(a.address) === null))
      return [{ address: a.address, mint: new PublicKey(b.subarray(10, 42)).toBase58(),
        owner: new PublicKey(b.subarray(42, 74)).toBase58(), maxDebit: '0', minCredit: String(b.readBigUInt64LE(74)) }]
    })
    check(holdings.length === 5 + (compiled.postMintHoldings?.length ?? 0) && new Set(holdings.map(x => x.address)).size === holdings.length)
    const postMintHoldings = new Set((compiled.postMintHoldings ?? []).map(h => h.address))
    const hookWritable = [...new Set(compiled.selectedHookExtras.filter(x => x.writable && !postMintHoldings.has(x.address)).map(x => x.address))].sort()
    const canonical = new Set(post.accounts.map(x => x.address))
    check(hookWritable.every(address => !canonical.has(address) && observations.every(o => {
      const a = o.get(address)
      return a?.owner === ci.hookPin.program && !a.executable
    })))
    const hookPostStates = new Map()
    // The generic adapter hashes existing accounts only. Extend its read/sim request
    // to cover absent readonly PDAs too, and bind full original readonly metadata.
    const normalized = (a, simulated) => a === null ? null : ({ owner: simulated ? a.owner : a.owner.toBase58(),
      executable: a.executable, lamports: String(a.lamports), dataBase64: simulated ? a.data[0] : Buffer.from(a.data).toString('base64') })
    const verify = (addresses, accounts, simulated) => {
      for (const [address, original] of pins) {
        const wanted = original === null ? null : { owner: original.owner, executable: original.executable,
          lamports: original.lamports, dataBase64: original.dataBase64 }
        const actual = normalized(accounts[addresses.indexOf(address)], simulated)
        // Loaded absent transaction accounts appear as empty system placeholders
        // in Agave simulation, not persisted accounts. No funded/data state qualifies.
        const absent = simulated && wanted === null && isDeepStrictEqual(actual,
          { owner: '11111111111111111111111111111111', executable: false, lamports: '0', dataBase64: '' })
        check(absent || isDeepStrictEqual(actual, wanted))
      }
    }
    const wrapped = connections.map(({ provider, connection }) => ({ provider, connection: new Proxy(connection, {
      get(target, property) {
        if (property === 'getMultipleAccountsInfoAndContext') return async (keys, options) => {
          const addresses = [...new Set([...keys.map(k => k.toBase58()), ...pins.keys()])]
          check(addresses.length <= 100)
          const result = await target.getMultipleAccountsInfoAndContext(addresses.map(x => new PublicKey(x)), options)
          check(result.value.length === addresses.length); verify(addresses, result.value, false)
          return { ...result, value: result.value.slice(0, keys.length) }
        }
        if (property === 'simulateTransaction') return async (tx, options) => {
          const addresses = [...new Set([...options.accounts.addresses, ...pins.keys()])]
          // Agave caps returned accounts at the message account count. Repeat the
          // exact message for disjoint return slices, accepting only one bank and
          // identical execution metadata; never replace its blockhash or bytes.
          const batches = []
          for (let i = 0; i < addresses.length; i += review.accounts.length) {
            const slice = addresses.slice(i, i + review.accounts.length)
            const result = await target.simulateTransaction(tx, { ...options, accounts: { ...options.accounts, addresses: slice } })
            check(result.value.accounts?.length === slice.length)
            batches.push(result)
          }
          const metadata = result => { const { accounts, ...value } = result.value; return { context: result.context, value } }
          if (batches.some(result => result.context.slot !== batches[0].context.slot))
            throw Object.assign(Error('Finalized bank advanced between simulation return slices'), { code: 'SELECTED_HOOK_SIMULATION_BANK_ADVANCED' })
          check(batches.every(result => isDeepStrictEqual(metadata(result), metadata(batches[0]))))
          const accounts = batches.flatMap(result => result.value.accounts)
          verify(addresses, accounts, true)
          const hashes = Object.fromEntries(hookWritable.map(address => {
            const a = normalized(accounts[addresses.indexOf(address)], true)
            check(a?.owner === ci.hookPin.program && !a.executable)
            return [address, sha(JSON.stringify({ address, owner: a.owner, executable: a.executable, dataBase64: a.dataBase64 }))]
          }))
          hookPostStates.set(provider, hashes)
          return { ...batches[0], value: { ...batches[0].value, accounts: accounts.slice(0, options.accounts.addresses.length) } }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) }))
    const result = await collectSelectedHookSimulation({ review, conditions: { tokenProgram, configurationSha256, holdings,
      native: [{ address: review.payer, maxDebit: review.maxNativeDebitLamports, minCredit: '0' }],
      unchanged: [...pins].filter(([, a]) => a !== null).map(([address, a]) => ({ address, sha256: sha(Buffer.from(a.dataBase64, 'base64')) })) },
    connections: wrapped, expected, clock })
    const hookPostStateHashes = hookPostStates.get(connections[0].provider)
    check(hookPostStateHashes && isDeepStrictEqual(hookPostStateHashes, hookPostStates.get(connections[1].provider)))
    if (expected) check(isDeepStrictEqual(hookPostStateHashes, expected.hookPostStateHashes))
    return Object.freeze({ ...result, hookPostStateHashes })
  } catch {
    throw Object.assign(Error('Exact-message selected launch simulation unavailable or changed; preserve review and require new consent.'), { code: 'SELECTED_HOOK_SIMULATION_UNAVAILABLE' })
  }
}
