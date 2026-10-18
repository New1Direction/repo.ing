// Human preview: every instruction decoded from the actual message bytes with labeled accounts.
import BN from 'bn.js'
import { PublicKey, SystemInstruction, TransactionMessage, VersionedMessage, AddressLookupTableInstruction, ComputeBudgetInstruction } from '@solana/web3.js'
import { loadArtifacts } from './artifacts.mjs'
import { lookupAccount } from './message.mjs'
import { LOADER, SYSTEM, ALT_PROGRAM, COMPUTE_BUDGET, derivedAddresses, holdingAddress } from './pins.mjs'

const LAMPORTS_PER_SOL = 1000000000n
export const sol = lamports => { const v = BigInt(String(lamports)), whole = v / LAMPORTS_PER_SOL, frac = (v % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, ''); return `${whole}${frac ? '.' + frac : ''} SOL` }
export function plain(value) {
  if (value === null || value === undefined) return value ?? null
  if (BN.isBN(value)) return value.toString(10)
  if (value instanceof PublicKey) return value.toBase58()
  if (typeof value === 'bigint') return value.toString(10)
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('hex')
  if (Array.isArray(value)) return value.length && value.every(x => Number.isInteger(x) && x >= 0 && x < 256) && value.length >= 8 ? Buffer.from(value).toString('hex') : value.map(plain)
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]))
  return value
}
export function addressBook({ programs, quoteMint, roles, extra = {} }) {
  const d = derivedAddresses(programs, quoteMint), book = new Map()
  for (const [role, address] of Object.entries(roles)) if (address) book.set(address, `${role}`)
  for (const [name, address] of Object.entries(programs)) book.set(address, `${name} program`)
  for (const [name, address] of Object.entries(d)) if (!book.has(address)) book.set(address, name)
  for (const role of ['creator', 'treasury']) if (roles[role]) book.set(holdingAddress(quoteMint, roles[role], programs.token), `${role} quote holding`)
  for (const [name, address] of Object.entries(extra)) if (address && !book.has(address)) book.set(address, name)
  book.set(SYSTEM, 'system program'); book.set(LOADER, 'upgradeable loader'); book.set(ALT_PROGRAM, 'lookup-table program'); book.set(COMPUTE_BUDGET, 'compute budget')
  return book
}
function decodeKnown(ix, programs) {
  const program = ix.programId.toBase58()
  if (program === COMPUTE_BUDGET) {
    const type = ComputeBudgetInstruction.decodeInstructionType(ix)
    return type === 'SetComputeUnitLimit' ? { name: 'SetComputeUnitLimit', args: { units: ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix).units } }
      : { name: type, args: plain(ComputeBudgetInstruction.decodeSetComputeUnitPrice(ix)) }
  }
  if (program === SYSTEM) {
    const type = SystemInstruction.decodeInstructionType(ix)
    if (type === 'Transfer') { const t = SystemInstruction.decodeTransfer(ix); return { name: 'Transfer', args: { lamports: t.lamports.toString(), sol: sol(t.lamports) }, names: ['from', 'to'] } }
    return { name: type, args: {} }
  }
  if (program === LOADER) {
    const tag = ix.data.readUInt32LE(0)
    if (tag === 4) return { name: 'SetAuthority', args: { newAuthority: ix.keys[2]?.pubkey.toBase58() ?? 'NONE -> program becomes IMMUTABLE (irreversible)' }, names: ['program_data', 'current_authority', 'new_authority'] }
    return { name: `loader-instruction-${tag}`, args: {} }
  }
  if (program === ALT_PROGRAM) {
    const type = AddressLookupTableInstruction.decodeInstructionType(ix)
    if (type === 'CreateLookupTable') { const c = AddressLookupTableInstruction.decodeCreateLookupTable(ix); return { name: type, args: { recentSlot: String(c.recentSlot) }, names: ['table', 'authority', 'payer', 'system_program'] } }
    if (type === 'ExtendLookupTable') { const e = AddressLookupTableInstruction.decodeExtendLookupTable(ix); return { name: type, args: { count: e.addresses.length, addresses: e.addresses.map(a => a.toBase58()) }, names: ['table', 'authority', 'payer', 'system_program'] } }
    if (type === 'FreezeLookupTable') return { name: 'FreezeLookupTable (PERMANENT: addresses and rent locked forever)', args: {}, names: ['table', 'authority'] }
    return { name: type, args: {} }
  }
  const role = Object.entries(programs).find(([, address]) => address === program)?.[0]
  if (!role) return { name: 'UNKNOWN PROGRAM', args: { dataHex: ix.data.toString('hex') } }
  const { coders, idls } = loadArtifacts(), decoded = coders[role].instruction.decode(ix.data)
  if (!decoded) return { name: `UNDECODABLE ${role} instruction`, args: { dataHex: ix.data.toString('hex') } }
  const definition = idls[role].instructions.find(x => x.name === decoded.name)
  return { name: `${role}.${decoded.name}`, args: plain(decoded.data), names: definition.accounts.map(a => a.name) }
}
/** Decode every instruction of the exact message bytes (resolving the lookup table, if any). */
export function decodeMessage(messageBase64, { programs, book, lookupTable = null }) {
  const message = VersionedMessage.deserialize(Buffer.from(messageBase64, 'base64'))
  const instructions = TransactionMessage.decompile(message, { addressLookupTableAccounts: lookupTable ? [lookupAccount(lookupTable)] : [] }).instructions
  return instructions.map((ix, index) => {
    const known = decodeKnown(ix, programs)
    return { index, program: ix.programId.toBase58(), programLabel: book.get(ix.programId.toBase58()) ?? 'unknown', instruction: known.name, args: known.args,
      accounts: ix.keys.map((k, i) => ({ name: known.names?.[i] ?? `remaining[${i - (known.names?.length ?? 0)}]`, address: k.pubkey.toBase58(),
        label: book.get(k.pubkey.toBase58()) ?? '', signer: k.isSigner, writable: k.isWritable })) }
  })
}
export function fieldDiff(before, after, prefix = '') {
  const out = []
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const a = before?.[key], b = after?.[key]
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) out.push(...fieldDiff(a, b, `${prefix}${key}.`))
    else if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field: `${prefix}${key}`, before: a, after: b })
  }
  return out
}
const short = s => typeof s === 'string' && s.length > 110 ? `${s.slice(0, 107)}...` : s
function flatten(value, prefix, out = []) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) { for (const [k, v] of Object.entries(value)) flatten(v, `${prefix}.${k}`, out) }
  else if (Array.isArray(value) && value.length > 3) out.push([prefix, `[${value.length} items] ${value.join(', ')}`])
  else out.push([prefix, JSON.stringify(value)])
  return out
}
export function renderPreview(p) {
  const lines = [`=== Hook Lab owner driver :: ${p.stage} (${p.network}) ===`, `genesis           ${p.genesisHash}`, `observed slot     ${p.observedSlot ?? "n/a (blocked before reading account state)"} (two providers: ${p.providers.join(', ')})`]
  if (p.blocked) lines.push('', `BLOCKED: ${p.blocked}`)
  for (const note of p.notes ?? []) lines.push(`note: ${note}`)
  if (p.decisions) lines.push(`decisions         ${p.decisions.map(d => `${d.name}=${JSON.stringify(d.value)}${d.approved ? ' (approved)' : ' (NOT approved)'}`).join('; ') || 'none'}`)
  if (p.messageSha256) {
    lines.push(`message sha256    ${p.messageSha256}`, `blockhash         ${p.blockhash}  lastValidBlockHeight ${p.lastValidBlockHeight}`)
    if (p.deadlineSlot !== undefined) lines.push(`deadline slot     ${p.deadlineSlot}`)
    lines.push(`fee payer         ${p.payer} (${p.book?.[p.payer] ?? ''})`, `required signers  ${p.requiredSigners.map(s => `${s} [${p.signerRoles[s] ?? '?'}]`).join(', ')}`)
    lines.push(`network fee       ${p.networkFeeLamports} lamports; wire ${p.wireBytes} bytes; lookup table ${p.lookupTable ?? 'none'}`)
    if (p.approvalFlag) lines.push(`execute requires  --message-sha256 ${p.messageSha256} --approved ${p.stage}:${p.messageSha256}`)
    for (const ix of p.instructions) {
      lines.push('', `[${ix.index}] ${ix.instruction}  (${ix.programLabel} ${ix.program})`)
      for (const [k, v] of Object.entries(ix.args ?? {})) for (const [name, text] of flatten(v, k)) lines.push(`      arg ${name} = ${text}`)
      for (const a of ix.accounts) lines.push(`      ${a.signer ? 'S' : '-'}${a.writable ? 'W' : '-'} ${a.name.padEnd(22)} ${a.address} ${a.label ? `(${a.label})` : ''}`)
    }
  }
  for (const section of p.sections ?? []) {
    lines.push('', `-- ${section.title}`)
    for (const row of section.rows) lines.push(`   ${row}`)
  }
  if (p.simulation) lines.push('', `-- simulation (read-only, sigVerify:false): err=${JSON.stringify(p.simulation.err)} units=${p.simulation.unitsConsumed}`, ...p.simulation.logs.map(l => `   | ${short(l)}`))
  return lines.join('\n')
}
