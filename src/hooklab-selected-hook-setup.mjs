// Server-only compiler/read collector. No keys, signing, sends or execution permission.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual as equal } from 'node:util'
import { z } from 'zod'
import { PublicKey, ComputeBudgetProgram, TransactionInstruction, TransactionMessage } from '@solana/web3.js'
import { hookAddress as key, hookRawAmount as u64 } from './hooklab-execution-contract.mjs'
import { selectedHookSchema, selectedHookAccountPlan } from './hooklab-selected-hook.mjs'
import { selectedAuthorityAccounts, assertSelectedAuthorityObserved } from './hooklab-selected-hook-preparation.mjs'
import { inspectHookLabMessage, verifyHookLabSignedMessage } from './hooklab-message-boundary.mjs'
import { collectSelectedHookSimulation, simulateSelectedHookAccounts } from './hooklab-selected-hook-simulation.mjs'
import { supplementalTableSchema, supplementalTableInstructions, assertFrozenSupplementalTable } from './hooklab-selected-launch-table.mjs'
const sha = b => createHash('sha256').update(b).digest('hex')
const check = (v, m = 'Selected-hook setup differs') => { if (!v) throw Error(m) }
const pk = v => new PublicKey(v)
const pda = (p, ...s) => PublicKey.findProgramAddressSync(s, pk(p))[0].toBase58()
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111', system = '11111111111111111111111111111111'
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v) } return v }
const meta = z.object({ address: key, signer: z.boolean(), writable: z.boolean() }).strict()
export const selectedHookSetupRequestSchema = z.object({ schema: z.literal('repoing/selected-hook-setup-request/1'), creator: key, mint: key,
  selectedHook: selectedHookSchema, instructions: z.array(z.object({ dataBase64: z.string().min(4).max(1024), accounts: z.array(meta).min(1).max(32) }).strict()).min(1).max(8),
}).strict()
const raw = s => { const b = Buffer.from(s, 'base64'); check(b.toString('base64') === s); return b }
const snapshotSchema = z.array(z.object({ address: key, account: z.object({ address: key, owner: key, executable: z.boolean(), lamports: u64, dataBase64: z.string().max(14000000) }).strict().nullable() }).strict()).max(100)

/** Input: immutable creator intent; operator-owned programs/hookPin, complete snapshots (including
 * nulls), context (review fields + recentBlockhash), limits (computeUnits, maxRentLamports,
 * maxNetworkFeeLamports, maxTotalDebitLamports). Output is offline-unverified, never authority.
 * maxRentLamports bounds ALL instruction debit (not merely a caller's claimed rent quote).
 * Snapshot identity is subsequently collected from two independent finalized RPC adapters.
 */
export function planSelectedHookSetup(input) {
  const r = selectedHookSetupRequestSchema.parse(input.request), snapshots = snapshotSchema.parse(input.snapshots)
  const { context: c, limits: l, programs, hookPin, selectedAuthorityEvidence } = structuredClone(input)
  const supplementalTable = input.supplementalTable ? supplementalTableSchema.parse(input.supplementalTable) : null
  const H = r.selectedHook.program, registry = pda(H, Buffer.from('bordrless-hook-accounts'), pk(r.mint).toBuffer()), programData = pda(loader, pk(H).toBuffer())
  const roles = [r.creator, r.mint, H, registry, programData, ...['token','swap','launch','gate'].map(k => key.parse(programs[k])), system, ComputeBudgetProgram.programId.toBase58()]
  check(new Set(roles).size === roles.length && hookPin.program === H, 'Setup roles alias or pin differs')
  check(PublicKey.isOnCurve(pk(r.creator).toBytes()), 'Creator must be a wallet')
  const privileges = new Map()
  const instructions = r.instructions.map(ix => {
    const data = raw(ix.dataBase64); check(data.length > 0 && data.length <= 768)
    check(new Set(ix.accounts.map(a => a.address)).size === ix.accounts.length, 'Duplicate setup role')
    for (const a of ix.accounts) {
      check((!a.signer || a.address === r.creator) && (!a.writable || ![r.mint, H, programData, ...Object.values(programs), system, ComputeBudgetProgram.programId.toBase58()].includes(a.address)), 'Setup privilege expansion')
      check(!privileges.has(a.address) || equal(privileges.get(a.address), a), 'Cross-instruction privilege alias')
      check(a.address !== r.creator || (a.signer && a.writable), 'Creator privilege alias')
      privileges.set(a.address, a)
    }
    return new TransactionInstruction({ programId: pk(H), data, keys: ix.accounts.map(a => ({ pubkey: pk(a.address), isSigner: a.signer, isWritable: a.writable })) })
  })
  check(r.instructions.some(i => i.accounts.some(a => a.address === registry && a.writable)), 'Irrelevant setup: registry must be writable')
  const units = z.number().int().min(1).max(1400000).parse(l.computeUnits)
  const rent = BigInt(u64.parse(l.maxRentLamports)), fee = BigInt(u64.parse(c.baseFeeLamports))
  check(rent > 0n && fee > 0n && fee <= BigInt(u64.parse(l.maxNetworkFeeLamports)) && rent + fee <= BigInt(u64.parse(l.maxTotalDebitLamports)), 'Setup rent/network/debit cap exceeded')
  if (supplementalTable) {
    check(supplementalTable.recentSlot <= c.observedSlot && c.observedSlot - supplementalTable.recentSlot < 150
      && BigInt(supplementalTable.rentLamports) < rent && !roles.includes(supplementalTable.address) && !privileges.has(supplementalTable.address), 'Supplemental table identity, slot or rent cap differs')
    instructions.push(...supplementalTableInstructions(r.creator, supplementalTable))
  }
  const message = new TransactionMessage({ payerKey: pk(r.creator), recentBlockhash: key.parse(c.recentBlockhash), instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0n }), ...instructions] }).compileToV0Message()
  const keys = message.getAccountKeys(), bytes = Buffer.from(message.serialize())
  check(1 + 64 * message.header.numRequiredSignatures + bytes.length <= 1232, 'Hook setup and supplemental table exceed the 1232-byte packet limit; configuration is unsupported')
  const accounts = Array.from({ length: keys.length }, (_, i) => ({ address: keys.get(i).toBase58(), signer: message.isAccountSigner(i), writable: message.isAccountWritable(i) }))
  const inventory = [...new Set([...accounts.map(a => a.address), programData, ...selectedAuthorityAccounts(selectedAuthorityEvidence).map(a => a.address)])].sort()
  check(equal(snapshots.map(a => a.address).sort(), inventory) && new Set(snapshots.map(a => a.address)).size === snapshots.length, 'Incomplete setup inventory')
  const state = new Map(snapshots.map(a => { check(!a.account || (a.account.address === a.address && raw(a.account.dataBase64).length <= 10485805)); return [a.address, a.account] }))
  assertSelectedAuthorityObserved(selectedAuthorityEvidence, state, c.genesisHash)
  const payer = state.get(r.creator)
  check(payer?.owner === system && !payer.executable && raw(payer.dataBase64).length === 0 && BigInt(payer.lamports) >= rent + fee, 'Invalid or insufficient payer')
  check(!state.get(registry), 'Registry already exists; require fresh intent')
  if (supplementalTable) check(state.get(supplementalTable.address) === null, 'Supplemental table already exists; reconcile the original setup')
  // Validate Program/ProgramData even before the registry exists, with a canonical empty layout.
  const selected = selectedHookAccountPlan({ programs, selectedHook: r.selectedHook, mint: r.mint,
    registry: { address: registry, owner: H, executable: false, dataBase64: Buffer.from('02daf6662c38c0cd0100000000','hex').toString('base64') },
    programAccount: state.get(H), programData: state.get(programData), elfSha256: hookPin.elfSha256, mintStable: true, selectedAuthorityEvidence })
  check(raw(state.get(programData).dataBase64).readBigUInt64LE(4) <= BigInt(c.observedSlot))
  for (const a of accounts.filter(a => a.writable && a.address !== r.creator)) check(!state.get(a.address)?.executable && (!state.get(a.address) || state.get(a.address).owner === H), 'Mutable account is not hook state')
  const policySha256 = sha(JSON.stringify({ programs, hookPin, snapshots, limits: l, flags: selected.flags, selectedAuthorityEvidence, ...(supplementalTable ? { supplementalTable } : {}) }))
  const review = { schema: 'hooklab-message-review/1', operation: 'selected-hook-setup', genesisHash: c.genesisHash, profileSha256: c.profileSha256, policySha256,
    intentSha256: sha(JSON.stringify(r)), payer: r.creator, wallet: r.creator, messageBase64: bytes.toString('base64'), messageSha256: sha(bytes), requiredSigners: [r.creator], accounts, lookupTables: [],
    observedSlot: c.observedSlot, validUntilSlot: c.validUntilSlot, observedAtMs: c.observedAtMs, reviewExpiresAtMs: c.reviewExpiresAtMs, lastValidBlockHeight: c.lastValidBlockHeight,
    baseFeeLamports: String(fee), maxFeeLamports: l.maxNetworkFeeLamports, instructionDebitLamports: String(rent), maxNativeDebitLamports: String(rent + fee),
    ...(supplementalTable ? { supplementalTableCost: { address: supplementalTable.address, rentLamports: supplementalTable.rentLamports, permanentFreeze: true } } : {}) }
  inspectHookLabMessage(review)
  check(c.validUntilSlot - c.observedSlot <= 150 && c.reviewExpiresAtMs - c.observedAtMs <= 60000, 'Setup review window too wide')
  return freeze({ schema: 'repoing/selected-hook-setup-plan/1', status: 'offline-unverified-setup', request: r, programs, hookPin, snapshots, context: c, limits: l, registry, programData, review,
    ...(selectedAuthorityEvidence ? { selectedAuthorityEvidence } : {}), ...(supplementalTable ? { supplementalTable } : {}), canSign: false, canSubmit: false })
}

/** Collect live exact-message simulation, not two caller-supplied objects. Connections/plan are
 * server-owned; retain plan and result for revalidation. No permission to sign/send is returned.
 * All readonly identities (including absent mint) and executable state are compared in full.
 */
export async function collectSelectedHookSetup({ plan, connections, expected, signedBase64, clock = Date.now }) {
  const p = planSelectedHookSetup(plan)
  check(equal(p, plan), 'Retained setup plan/message changed')
  if (signedBase64 !== undefined) verifyHookLabSignedMessage(p.review, signedBase64)
  check(connections?.length === 2 && connections[0].connection !== connections[1].connection && new Set(connections.map(c => c.provider)).size === 2)
  const writable = new Set(p.review.accounts.filter(a => a.writable).map(a => a.address))
  const state = new Map(p.snapshots.map(a => [a.address, a.account]))
  const normalized = (a, simulated = false) => a === null ? null : ({ owner: simulated ? a.owner : a.owner.toBase58(), executable: a.executable,
    lamports: String(a.lamports), dataBase64: simulated ? a.data[0] : Buffer.from(a.data).toString('base64') })
  const bare = a => { if (!a) return null; const { address, ...rest } = a; return rest }
  const post = []
  const wrapped = connections.map(({ provider, connection }, index) => ({ provider, connection: new Proxy(connection, { get(target, prop) {
    if (prop === 'getMultipleAccountsInfoAndContext') return async (keys, options) => {
      const result = await target.getMultipleAccountsInfoAndContext(keys, options)
      check(result.value.length === keys.length)
      result.value.forEach((a,i) => check(equal(normalized(a), bare(state.get(keys[i].toBase58()))), 'Pinned setup prestate changed'))
      return result
    }
    if (prop === 'simulateTransaction') return async (tx, options) => {
      check(Buffer.from(tx.message.serialize()).toString('base64') === p.review.messageBase64)
      const result = await simulateSelectedHookAccounts(target, tx, options)
      const after = new Map(options.accounts.addresses.map((address,i) => [address, normalized(result.value.accounts[i], true)]))
      let growth = 0n
      for (const [address,a] of after) {
        const before = bare(state.get(address))
        if (!writable.has(address)) {
          // Agave returns a canonical empty system account for an absent readonly
          // message key. Any funding, data, owner or executable change still fails.
          const absent = before === null && equal(a, { owner: system, executable: false, lamports: '0', dataBase64: '' })
          check(absent || equal(a, before), 'Readonly setup identity changed')
        }
        else if (address === p.request.creator) check(a && a.owner === system && !a.executable && a.dataBase64 === before.dataBase64)
        else if (address === p.supplementalTable?.address) {
          assertFrozenSupplementalTable({ address, ...a }, p.supplementalTable, result.context.slot)
          check(BigInt(a.lamports) === BigInt(p.supplementalTable.rentLamports), 'Supplemental table rent differs from disclosure')
          growth += BigInt(a.lamports)
        } else {
          check(!a || (!a.executable && a.owner === p.request.selectedHook.program && raw(a.dataBase64).length <= 16384), 'Executable or foreign mutable state')
          const delta = BigInt(a?.lamports ?? '0') - BigInt(before?.lamports ?? '0'); if (delta > 0n) growth += delta
        }
      }
      check(growth <= BigInt(p.limits.maxRentLamports), 'Setup rent cap exceeded')
      const registry = after.get(p.registry)
      check(registry && !equal(registry, bare(state.get(p.registry))), 'Missing setup registry')
      const selected = selectedHookAccountPlan({ programs: p.programs, selectedHook: p.request.selectedHook, mint: p.request.mint,
        registry: { address: p.registry, ...registry }, programAccount: state.get(p.request.selectedHook.program), programData: state.get(p.programData), elfSha256: p.hookPin.elfSha256, mintStable: true, selectedAuthorityEvidence: p.selectedAuthorityEvidence })
      // Creation's lastExtendedSlot is the execution bank, not a wallet-controlled
      // field. Validate it above, then normalize only that clock for revalidation.
      const stableAfter = [...after].map(([address, a]) => {
        if (address !== p.supplementalTable?.address) return [address, a]
        const b = raw(a.dataBase64); b.writeBigUInt64LE(0n, 12)
        return [address, { ...a, dataBase64: b.toString('base64') }]
      })
      post[index] = { accounts: stableAfter, commitment: selected.commitment, flags: selected.flags, registry: { address: p.registry, ...registry } }
      return result
    }
    const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value
  } }) }))
  const conditions = { tokenProgram: p.programs.token, configurationSha256: p.review.policySha256, holdings: [], native: [{ address: p.request.creator, maxDebit: p.review.maxNativeDebitLamports, minCredit: '0' }],
    unchanged: p.snapshots.filter(a => !writable.has(a.address) && a.account).map(a => ({ address: a.address, sha256: sha(raw(a.account.dataBase64)) })) }
  // Include absent readonly accounts too: generic simulator's unchanged pins require existence.
  // A proxy extends the RPC inventory; generic simulator still validates exact message and all deltas.
  const missing = p.snapshots.filter(a => !writable.has(a.address) && !a.account).map(a => a.address)
  const extended = wrapped.map(({ provider, connection }) => ({ provider, connection: new Proxy(connection, { get(target, prop) {
    if (prop === 'getMultipleAccountsInfoAndContext') return async (keys, opts) => { const all = [...keys, ...missing.map(pk)], result = await target.getMultipleAccountsInfoAndContext(all, opts); return { ...result, value: result.value.slice(0, keys.length) } }
    if (prop === 'simulateTransaction') return async (tx, opts) => { const addresses = [...opts.accounts.addresses, ...missing], result = await target.simulateTransaction(tx, { ...opts, accounts: { ...opts.accounts, addresses } }); return { ...result, value: { ...result.value, accounts: result.value.accounts.slice(0, opts.accounts.addresses.length) } } }
    return Reflect.get(target, prop)
  } }) }))
  const simulation = await collectSelectedHookSimulation({ review: p.review, conditions, connections: extended, clock })
  check(equal(post[0], post[1]), 'Setup providers disagree')
  const result = freeze({ schema: 'repoing/selected-hook-setup-evidence/1', simulation, postStateSha256: sha(JSON.stringify(post[0])), registryCommitment: post[0].commitment, registry: post[0].registry, flags: post[0].flags, canSign: false, canSubmit: false })
  if (expected) check(equal(result, expected), 'Setup revalidation changed')
  return result
}
export async function revalidateSelectedHookSetup(input) {
  check(input.expected, 'Retained setup evidence required')
  return collectSelectedHookSetup(input)
}

/** Pinned reference 7fde540 programs/tax_hook::prepare(u16,u16), not install.
 * Public collector OWNER, not its holding. Program identity remains an independent operator pin.
 * Tax flags are 1<<0 | 1<<6; generic setup above is deliberately not tax-specific.
 */
export function taxHookPrepareIntent({ creator, mint, program, collector, feeBps, maxWalletBps }) {
  [creator, mint, program, collector].forEach(v => key.parse(v))
  check(new Set([creator,mint,program,collector,system]).size === 5, 'Tax prepare roles alias')
  z.number().int().min(0).max(2000).parse(feeBps); z.number().int().min(0).max(10000).parse(maxWalletBps)
  const data = Buffer.alloc(12); createHash('sha256').update('global:prepare').digest().copy(data,0,0,8); data.writeUInt16LE(feeBps,8); data.writeUInt16LE(maxWalletBps,10)
  const accounts = [creator,mint,collector,pda(program,Buffer.from('tax'),pk(mint).toBuffer()),pda(program,Buffer.from('bordrless-hook-accounts'),pk(mint).toBuffer()),system]
    .map((address,i) => ({ address, signer: i === 0, writable: [0,3,4].includes(i) }))
  return freeze(selectedHookSetupRequestSchema.parse({ schema: 'repoing/selected-hook-setup-request/1', creator, mint, selectedHook: { program, flags: 65 }, instructions: [{ dataBase64: data.toString('base64'), accounts }] }))
}
