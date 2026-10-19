// Shared stage helpers: decoding, governance prediction, blockhash pinning, simple compilation.
import BN from 'bn.js'
import { loadArtifacts } from '../artifacts.mjs'
import { governanceCommitment } from '../instructions.mjs'
import { readBlockhash, blockhashStillValid } from '../rpc.mjs'
import { compileReviewed } from '../message.mjs'
import { budget } from '../instructions.mjs'
import { plain } from '../preview.mjs'

export const check = (ok, message) => { if (!ok) throw Error(message) }
export const hex = b => Buffer.from(b).toString('hex')
// abi: the run's stack ABI (ctx.abi); the legacy bundle-2 IDLs when omitted.
export function decode(role, type, account, abi = loadArtifacts()) {
  check(account, `Account for ${role}.${type} is missing`)
  return abi.coders[role].accounts.decode(type, Buffer.from(account.dataBase64, 'base64'))
}
export function owned(accounts, address, owner, label) {
  const account = accounts.get(address)
  check(account && account.owner === owner && !account.executable, `${label} ${address} is missing or not owned by ${owner}`)
  return account
}
export function governanceView(role, state, commit = governanceCommitment) {
  return { revision: state.revision.toString(10), gates: { ...state.gates }, commitment: hex(commit(role, state)),
    admin: state.roles.admin.toBase58(), treasury: state.roles.treasury.toBase58(), pendingAdmin: state.pending_admin ? plain(state.pending_admin) : null }
}
export function nextState(state, change) {
  return { ...state, ...change, roles: { ...state.roles, ...(change.roles ?? {}) }, revision: state.revision.add(new BN(1)) }
}
export function governanceSection(role, before, after, commit = governanceCommitment) {
  const b = governanceView(role, before, commit), a = governanceView(role, after, commit)
  return { title: `${role} governance (before -> after)`, rows: [`revision    ${b.revision} -> ${a.revision}`, `commitment  ${b.commitment} -> ${a.commitment}`,
    `gates       creation=${b.gates.creation} trading=${b.gates.trading} -> creation=${a.gates.creation} trading=${a.gates.trading} (true = closed)`] }
}
// The same, under the run's stack ABI (ctx.ix, ctx.abi): every stage that can run on our own stack uses these.
export const gview = (ctx, role, state) => governanceView(role, state, ctx.ix.governanceCommitment)
export const gsection = (ctx, role, before, after) => governanceSection(role, before, after, ctx.ix.governanceCommitment)
export const cdecode = (ctx, role, type, account) => decode(role, type, account, ctx.abi)
/** Reuse the reviewed blockhash while both providers still accept it; otherwise fetch a fresh one. */
export async function blockhashFor(ctx, pinned, minSlot = 0) {
  if (pinned?.blockhash && await blockhashStillValid(ctx.readers, pinned.blockhash)) {
    const [heights, slots] = await Promise.all([Promise.all(ctx.readers.map(r => r.connection.getBlockHeight({ commitment: 'finalized' }))),
      Promise.all(ctx.readers.map(r => r.connection.getSlot('finalized')))])
    return { blockhash: pinned.blockhash, lastValidBlockHeight: pinned.lastValidBlockHeight, currentBlockHeight: Math.max(...heights), observedSlot: Math.max(...slots), reused: true }
  }
  return { ...await readBlockhash(ctx.readers, minSlot), reused: false }
}
export const unitsPrice = ctx => String(ctx.config.decisions.computeUnitPriceMicroLamports.value)
/** Compile an owner-assembled instruction list behind the standard compute-budget prefix. */
export async function simpleMessage(ctx, { stage, payer, instructions, pinned, snapshot, units = 200000, lookupTable = null, instructionDebitLamports = '0', policy }) {
  const bh = await blockhashFor(ctx, pinned, snapshot.slot)
  const { review } = compileReviewed({ operation: stage, genesisHash: ctx.genesis, profileSha256: ctx.envelope.expectedSha256, payer, wallet: payer,
    instructions: [...budget(units, unitsPrice(ctx)), ...instructions], blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight,
    lookupTable, observedSlot: Math.max(snapshot.slot, bh.observedSlot), observedAtMs: snapshot.observedAtMs, validUntilSlot: Math.max(snapshot.slot, bh.observedSlot) + 150,
    units, microLamports: unitsPrice(ctx), instructionDebitLamports, policy: policy ?? snapshot.observations[0].accounts })
  return { review, blockhash: bh }
}
export function roleOf(ctx, address) {
  return Object.entries(ctx.roles).find(([, a]) => a === address)?.[0] ?? null
}
export function signerRoles(ctx, review) {
  return Object.fromEntries(review.requiredSigners.map(s => [s, roleOf(ctx, s) ?? 'UNMAPPED']))
}
